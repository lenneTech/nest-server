/**
 * What a developer reads in the API terminal of a freshly created project (12.7.2, DEV-4131 / DEV-4128).
 *
 * The behaviour of the server is unchanged by every case here. They pin lines that said something false: a mail
 * reported as sent that never left the process, a migration reported for a user who was never migrated, a stack
 * trace for an expected 404, and a start address that does not open everywhere.
 */
import type { INestApplication } from '@nestjs/common';
import { HttpStatus, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { sha256 } from 'js-sha256';
import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpExceptionLogFilter } from '../../src/core/common/filters/http-exception-log.filter';
import { serverDisplayUrl } from '../../src/core/common/helpers/server-url.helper';
import { EmailService } from '../../src/core/common/services/email.service';
import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';
import { CoreBetterAuthUserMapper } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('EmailService.deliversMail()', () => {
  const emailService = (smtp: unknown) =>
    new EmailService({ get: () => smtp, getFastButReadOnly: () => undefined } as any, {} as any);

  it('answers false for a transport that only renders mail', () => {
    expect(emailService({ jsonTransport: true }).deliversMail()).toBe(false);
    expect(emailService({ streamTransport: true }).deliversMail()).toBe(false);
  });

  it('answers true for an SMTP server and for a configuration it cannot judge', () => {
    expect(emailService({ host: 'smtp.example.com', port: 587 }).deliversMail()).toBe(true);
    expect(emailService({ host: 'smtp.example.com', jsonTransport: undefined }).deliversMail()).toBe(true);
    expect(emailService(undefined).deliversMail()).toBe(true);
  });
});

describe('the outcome line of an auth mail (DEV-4131)', () => {
  const USER = { email: 'local.user@test.com', id: 'u1', name: 'Local User' };

  function service(delivers: boolean, info: unknown = { messageId: 'x' }) {
    const configService = {
      getFastButReadOnly: (key: string) =>
        key === 'betterAuth.emailVerification'
          ? { locale: 'en', resendCooldownSeconds: 60 }
          : key === 'env'
            ? 'local'
            : undefined,
    } as any;
    const emailService = { deliversMail: () => delivers, sendMail: vi.fn(async () => info) } as any;
    const svc = new CoreBetterAuthEmailVerificationService(
      configService,
      emailService,
      undefined,
      undefined,
      undefined,
    ) as any;
    const warn = vi.spyOn(svc.logger, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(svc.logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    return { debug, svc, warn };
  }

  /**
   * @regression   12.7.2 (DEV-4131) — without SMTP a starter-based project sends through `jsonTransport`, which renders
   *   the mail and delivers nothing; the API logged "Verification email sent to …" all the same, and the link was
   *   lost between the debug lines.
   * @seen-failing Log "sent" without asking `deliversMail()` in logAuthMailOutcome() in
   *   src/core/modules/better-auth/core-better-auth-email-verification.service.ts — registered as mutation
   *   `auth-mail-logged-as-sent-without-transport` in tests/regression-mutations.json.
   */
  it('says that no mail went out, and where the link is, when the transport only renders mail', async () => {
    vi.stubEnv('NODE_ENV', 'local');
    const { debug, svc, warn } = service(false);
    await svc.sendPasswordResetEmail({ token: 't', url: 'https://api.test.local/iam/reset-password/t', user: USER });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^No password-reset email was sent to /);
    expect(String(warn.mock.calls[0][0])).toContain('[PASSWORD RESET] line above');
    expect(debug.mock.calls.map(([line]) => String(line))).not.toContainEqual(expect.stringMatching(/email sent to/));
  });

  it('names the configuration instead when this process prints no link line', () => {
    vi.stubEnv('LT_LOG_AUTH_URLS', '0');
    const { svc, warn } = service(false);
    svc.logAuthMailOutcome('Verification', 'EMAIL VERIFICATION', USER.email, { messageId: 'x' });

    expect(String(warn.mock.calls[0][0])).toMatch(/^No verification email was sent to .*Configure email\.smtp/);
  });

  it('still says "sent" for a real delivery, and "captured" for the Hub mailbox', () => {
    const delivering = service(true);
    delivering.svc.logAuthMailOutcome('Verification', 'EMAIL VERIFICATION', USER.email, { messageId: 'x' });
    expect(delivering.warn).not.toHaveBeenCalled();
    expect(String(delivering.debug.mock.calls.at(-1)?.[0])).toMatch(/^Verification email sent to /);

    const captured = service(true);
    captured.svc.logAuthMailOutcome('Verification', 'EMAIL VERIFICATION', USER.email, { captured: true });
    expect(captured.warn).not.toHaveBeenCalled();
    expect(String(captured.debug.mock.calls.at(-1)?.[0])).toMatch(/captured in the Hub mailbox/);
  });
});

describe('"Migrated legacy user" only for a real migration (DEV-4128)', () => {
  const PASSWORD = 'Legacy-Password-1';

  async function mapper(existingAccount: boolean) {
    const userId = new ObjectId();
    const users = {
      findOne: vi.fn(async () => ({
        _id: userId,
        email: 'synced@test.com',
        iamId: existingAccount ? userId.toHexString() : undefined,
        password: await bcrypt.hash(sha256(PASSWORD), 4),
      })),
      updateOne: vi.fn(async () => ({})),
    };
    const accounts = {
      findOne: vi.fn(async () => (existingAccount ? { providerId: 'credential', userId } : null)),
      insertOne: vi.fn(async () => ({ insertedId: new ObjectId() })),
    };
    const connection = { collection: (name: string) => (name === 'users' ? users : accounts) };
    const instance = new CoreBetterAuthUserMapper(connection as never) as any;
    const log = vi.spyOn(instance.logger, 'log').mockImplementation(() => undefined);
    return { accounts, instance, log };
  }

  /**
   * @regression   12.7.2 (DEV-4128) — `migrateAccountToIam()` also answers `true` when the credential account exists
   *   already, which is every sign-in of a user whose legacy password the sign-up synchronised; the sign-in logged
   *   "Migrated legacy user … to IAM" for a user registered a minute earlier.
   * @seen-failing Log the migration on the existing-account fast path of migrateAccountToIam() in
   *   src/core/modules/better-auth/core-better-auth-user.mapper.ts — registered as mutation
   *   `migration-logged-for-existing-account` in tests/regression-mutations.json.
   */
  it('logs nothing when the user has its IAM account already', async () => {
    const { instance, log } = await mapper(true);

    expect(await instance.migrateAccountToIam('synced@test.com', PASSWORD)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs once, with the address masked, when it creates the account', async () => {
    const { accounts, instance, log } = await mapper(false);

    expect(await instance.migrateAccountToIam('synced@test.com', PASSWORD)).toBe(true);
    expect(accounts.insertOne).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/^Migrated legacy user .+ to IAM$/);
    expect(String(log.mock.calls[0][0])).not.toContain('synced@test.com');
  });
});

describe('HttpExceptionLogFilter: a 404 without its stack (DEV-4128)', () => {
  function host() {
    const json = vi.fn();
    const res = { json, status: vi.fn(() => res) };
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getResponse: () => res }),
    } as any;
  }

  /**
   * @regression   12.7.2 (DEV-4128) — the frontends ask `GET /ai/status` on every page; with the AI module off each
   *   answer is a 404, and the filter logged its full stack trace every time.
   * @seen-failing Log the stack for every status in HttpExceptionLogFilter.catch() in
   *   src/core/common/filters/http-exception-log.filter.ts — registered as mutation `not-found-logged-with-stack` in
   *   tests/regression-mutations.json.
   */
  it('logs one line for a 404', () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    new HttpExceptionLogFilter().catch(new NotFoundException('Cannot GET /ai/status'), host());

    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0][0])).toBe('404 Cannot GET /ai/status');
  });

  it('keeps the stack for every other status', () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const error = new UnprocessableEntityException('invalid');
    new HttpExceptionLogFilter().catch(error, host());

    expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(String(debug.mock.calls[0][0])).toBe(error.stack);
  });
});

describe('serverDisplayUrl() (DEV-4128)', () => {
  const app = (url: string, address: string) =>
    ({
      getHttpServer: () => ({
        address: () => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4', port: 3000 }),
      }),
      getUrl: async () => url,
    }) as unknown as INestApplication;

  /**
   * @regression   12.7.2 (DEV-4128) — with no host configured Node binds to `::`, and the start message read
   *   `http://[::1]:3000`, an address that does not open on every system.
   * @seen-failing Return `app.getUrl()` unchanged in serverDisplayUrl() in
   *   src/core/common/helpers/server-url.helper.ts — registered as mutation `start-url-names-one-loopback-family` in
   *   tests/regression-mutations.json.
   */
  it('answers localhost for a server bound to every interface', async () => {
    expect(await serverDisplayUrl(app('http://[::1]:3000', '::'))).toBe('http://localhost:3000');
    expect(await serverDisplayUrl(app('http://127.0.0.1:3000', '0.0.0.0'))).toBe('http://localhost:3000');
  });

  it('keeps an address the server was bound to explicitly', async () => {
    expect(await serverDisplayUrl(app('http://127.0.0.1:3000', '127.0.0.1'))).toBe('http://127.0.0.1:3000');
    expect(await serverDisplayUrl(app('http://[::1]:3000', '::1'))).toBe('http://[::1]:3000');
  });
});
