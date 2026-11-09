/**
 * `betterAuth.emailVerification.appName` (12.8.3): the application name in the verification and password-reset mails —
 * subject, template variable, Brevo parameter — independent of `package.json`.
 *
 * Before, the name came from the `name` of the `package.json` in the working directory only. In a monorepo that is the
 * workspace package (`api`, `@acme/server`), and a project that wanted its product name in the subject had to override
 * `getAppName()`. Without the setting nothing changes.
 *
 * Constructed directly with stubs rather than through Nest, as in `better-auth-password-reset-email.spec.ts`.
 */
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatProjectName } from '../../src/core/modules/better-auth/better-auth.config';
import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';

const USER = { email: 'mail.user@test.com', id: 'u1', name: 'Mail User' };

/** What the mails said before the setting existed, and still say without it: the working directory's package name. */
const PACKAGE_NAME = formatProjectName(JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).name);

function createService(appName: unknown, opts: { brevo?: boolean } = {}) {
  const sendMailSmtp = vi.fn(async (_to: string, _subject: string, _payload: Record<string, any>) => ({
    messageId: 'smtp',
  }));
  const sendMailBrevo = vi.fn(async (_to: string, _templateId: number, _data: Record<string, unknown>) => ({
    messageId: 'brevo',
  }));
  const configService = {
    getFastButReadOnly: (key: string) => {
      if (key === 'betterAuth.emailVerification') {
        return {
          ...(appName === undefined ? {} : { appName }),
          ...(opts.brevo ? { brevoTemplateId: 11, passwordResetBrevoTemplateId: 12 } : {}),
          locale: 'en',
          resendCooldownSeconds: 0,
        };
      }
      if (key === 'env') return 'local';
      return undefined;
    },
  } as any;
  const service = new CoreBetterAuthEmailVerificationService(
    configService,
    { sendMail: sendMailSmtp } as any,
    undefined,
    opts.brevo ? ({ sendMail: sendMailBrevo } as any) : undefined,
    undefined,
  ) as any;
  return { sendMailBrevo, sendMailSmtp, service };
}

async function sendBoth(service: any) {
  await service.sendVerificationEmail({
    token: 'v',
    url: 'https://api.test.local/iam/verify-email?token=v',
    user: USER,
  });
  await service.sendPasswordResetEmail({ token: 'r', url: 'https://api.test.local/iam/reset-password/r', user: USER });
}

describe('betterAuth.emailVerification.appName', () => {
  let expectedWarnings: string[];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expectedWarnings = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(((message: unknown) => {
      expectedWarnings.push(String(message));
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * @regression   12.8.3 — the auth mails named the application after the `package.json` in the working directory and
   *   nothing else; a monorepo's API package name (`api`) became the subject of every verification and reset mail.
   * @seen-failing Drop the configured name from `resolveAppName()` in
   *   src/core/modules/better-auth/core-better-auth-email-verification.service.ts — registered as mutation
   *   `mail-app-name-config-ignored` in tests/regression-mutations.json.
   */
  it('names the configured application in subject and body of both mails', async () => {
    const { sendMailSmtp, service } = createService('Kundenportal');

    await sendBoth(service);

    expect(sendMailSmtp).toHaveBeenCalledTimes(2);
    const [verification, reset] = sendMailSmtp.mock.calls;
    expect(verification[1]).toBe('Kundenportal - Verify your email address');
    expect(verification[2].html).toContain('Kundenportal');
    expect(reset[1]).toBe('Kundenportal - Reset your password');
    expect(reset[2].html).toContain('Kundenportal');
    expect(verification[1]).not.toContain(PACKAGE_NAME);
  });

  it('hands the configured name to both Brevo templates', async () => {
    const { sendMailBrevo, service } = createService('Kundenportal', { brevo: true });

    await sendBoth(service);

    expect(sendMailBrevo).toHaveBeenCalledTimes(2);
    expect(sendMailBrevo.mock.calls.map(([, templateId, data]) => [templateId, data.appName])).toEqual([
      [11, 'Kundenportal'],
      [12, 'Kundenportal'],
    ]);
  });

  it('trims the configured name', async () => {
    const { sendMailSmtp, service } = createService('  Kundenportal  ');

    await sendBoth(service);

    expect(sendMailSmtp.mock.calls[0][1]).toBe('Kundenportal - Verify your email address');
  });

  it('keeps the package name without the setting, and for an empty one', async () => {
    for (const appName of [undefined, '', '   ']) {
      const { sendMailSmtp, service } = createService(appName);

      await sendBoth(service);

      expect(sendMailSmtp.mock.calls[0][1], String(appName)).toBe(`${PACKAGE_NAME} - Verify your email address`);
      expect(sendMailSmtp.mock.calls[1][1], String(appName)).toBe(`${PACKAGE_NAME} - Reset your password`);
    }
    expect(expectedWarnings).toEqual([]);
  });

  it('ignores a value that is not a string, with one warning naming the setting', async () => {
    const { sendMailSmtp, service } = createService({ de: 'Portal' });

    await sendBoth(service);

    expect(sendMailSmtp.mock.calls[0][1]).toBe(`${PACKAGE_NAME} - Verify your email address`);
    expect(expectedWarnings).toHaveLength(1);
    expect(expectedWarnings[0]).toContain('betterAuth.emailVerification.appName');
  });
});
