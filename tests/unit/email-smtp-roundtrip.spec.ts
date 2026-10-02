/**
 * EmailService against a REAL SMTP server — the one path no other suite touches.
 *
 * Every other mail test in the stack runs on `jsonTransport` (the e2e config, and every project
 * whose `config.env.ts` falls back to it without SMTP_HOST), so a mail library could change its
 * whole wire behaviour and every suite would stay green. That is not hypothetical: 11.41.5 moved
 * nodemailer across a major (9 → 10, a TypeScript rewrite), and before this file nothing ever sent
 * one message through a real SMTP handshake.
 *
 * An in-process `smtp-server` on 127.0.0.1 offers STARTTLS (its default self-signed certificate)
 * and allows AUTH only over TLS — the shape of a real submission port. The cases assert what
 * production depends on: the message arrives, over an UPGRADED connection, authenticated, with its
 * attachment. Refusals are paired with it, so a green run cannot come from a server that accepts
 * anything: a wrong password, and `requireTLS` against a server that cannot do STARTTLS. A further
 * case shows `requireTLS` upgrading even when the capability line is stripped — the downgrade an
 * on-path attacker would attempt, and the property `email.smtp.requireTLS` (default true since
 * 11.38.0) exists for.
 *
 * No MongoDB, so it lives in the unit runner.
 */
import type { AddressInfo, Server } from 'node:net';

import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { EmailService } from '../../src/core/common/services/email.service';
import { TemplateService } from '../../src/core/common/services/template.service';

/** The parts of `smtp-server` this file uses — the package ships no type declarations. */
interface SmtpSession {
  envelope: { mailFrom: false | { address: string }; rcptTo: { address: string }[] };
  secure: boolean;
  user?: string;
}
interface SmtpServerInstance {
  close(callback: () => void): void;
  listen(port: number, host: string, callback: () => void): void;
  server: Server;
}
const { SMTPServer } = createRequire(__filename)('smtp-server') as {
  SMTPServer: new (options: Record<string, unknown>) => SmtpServerInstance;
};

const USER = 'mailer';
const PASS = 'correct-horse-battery-staple';
const RECIPIENT = 'recipient@nest-server.test';

interface Received {
  raw: string;
  session: SmtpSession;
}

/** Starts an SMTP server on a free loopback port; `options` override the defaults. */
async function startSmtpServer(options: Record<string, unknown> = {}) {
  const received: Received[] = [];
  const server = new SMTPServer({
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(
      auth: { password: string; username: string },
      _session: unknown,
      callback: (e?: Error | null, r?: unknown) => void,
    ) {
      if (auth.username === USER && auth.password === PASS) {
        callback(null, { user: USER });
      } else {
        callback(new Error('Invalid username or password'));
      }
    },
    onData(stream: NodeJS.ReadableStream, session: SmtpSession, callback: (e?: Error | null) => void) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          raw: Buffer.concat(chunks).toString('utf8'),
          session: { envelope: session.envelope, secure: session.secure, user: session.user },
        });
        callback();
      });
    },
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  return {
    close: () => new Promise<void>((resolve) => server.close(resolve)),
    port,
    received,
  };
}

/** EmailService with just the config it reads; templates are not used here (html/text given). */
function emailService(): EmailService {
  const config: Record<string, string> = {
    'email.defaultSender.email': 'noreply@nest-server.test',
    'email.defaultSender.name': 'nest-server tests',
    env: 'local',
  };
  const configService = {
    get: (key: string) => config[key],
    getFastButReadOnly: (key: string) => config[key],
  } as unknown as ConfigService;
  return new EmailService(configService, {} as TemplateService);
}

/** SMTP options for the test server: STARTTLS on a plain port, its self-signed certificate accepted. */
function smtpOptions(port: number, overrides: Record<string, unknown> = {}) {
  return {
    auth: { pass: PASS, user: USER },
    host: '127.0.0.1',
    port,
    requireTLS: true,
    secure: false,
    tls: { rejectUnauthorized: false },
    ...overrides,
  };
}

describe('EmailService — a real SMTP round trip', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  async function setUp(serverOptions: Record<string, unknown> = {}) {
    const smtp = await startSmtpServer(serverOptions);
    const service = emailService();
    cleanups.push(smtp.close, () => service.onModuleDestroy());
    return { service, smtp };
  }

  it('delivers over an upgraded, authenticated connection — with its attachment', async () => {
    const { service, smtp } = await setUp();

    const result = await service.sendMail(RECIPIENT, 'SMTP round trip', {
      attachments: [{ content: 'attachment body', filename: 'note.txt' }],
      html: '<p>Hello over SMTP</p>',
      smtp: smtpOptions(smtp.port) as any,
      text: 'Hello over SMTP',
    });

    expect(result.accepted).toEqual([RECIPIENT]);
    expect(String(result.response)).toMatch(/^250/);
    expect(smtp.received).toHaveLength(1);
    const [mail] = smtp.received;
    expect(mail.session.secure, 'the connection must have been upgraded via STARTTLS').toBe(true);
    expect(mail.session.user).toBe(USER);
    expect(mail.session.envelope.mailFrom).toMatchObject({ address: 'noreply@nest-server.test' });
    expect(mail.session.envelope.rcptTo.map((r) => r.address)).toEqual([RECIPIENT]);
    expect(mail.raw).toMatch(/^Subject: SMTP round trip$/m);
    expect(mail.raw).toMatch(/^From: "nest-server tests" <noreply@nest-server\.test>$/m);
    expect(mail.raw).toContain('Hello over SMTP');
    expect(mail.raw).toMatch(/filename="?note\.txt"?/);
  });

  it('refuses a wrong password — and delivers nothing (the server really authenticates)', async () => {
    const { service, smtp } = await setUp();

    await expect(
      service.sendMail(RECIPIENT, 'must not arrive', {
        smtp: smtpOptions(smtp.port, { auth: { pass: 'wrong', user: USER } }) as any,
        text: 'x',
      }),
    ).rejects.toMatchObject({ code: 'EAUTH' });
    expect(smtp.received).toHaveLength(0);
  });

  it('with requireTLS, still upgrades when the STARTTLS capability line is stripped', async () => {
    // hideSTARTTLS removes STARTTLS from the EHLO reply but keeps the command working — what a
    // network middlebox stripping the capability produces. requireTLS makes the client issue
    // STARTTLS regardless, so the mail still travels encrypted instead of falling back to plaintext.
    const { service, smtp } = await setUp({ allowInsecureAuth: true, hideSTARTTLS: true });

    await service.sendMail(RECIPIENT, 'stripped capability', { smtp: smtpOptions(smtp.port) as any, text: 'x' });
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0].session.secure, 'requireTLS must have upgraded despite the hidden capability').toBe(
      true,
    );
  });

  it('with requireTLS, refuses a server that cannot do STARTTLS instead of sending in plaintext', async () => {
    // STARTTLS disabled outright, and allowInsecureAuth lets the server accept the credentials in
    // plaintext — so the ONLY thing standing between them and the wire is the client's requireTLS.
    const { service, smtp } = await setUp({ allowInsecureAuth: true, disabledCommands: ['STARTTLS'] });

    await expect(
      service.sendMail(RECIPIENT, 'must not arrive', { smtp: smtpOptions(smtp.port) as any, text: 'x' }),
    ).rejects.toThrow();
    expect(smtp.received).toHaveLength(0);
  });

  it('paired control: the same STARTTLS-less server does deliver once requireTLS is off', async () => {
    // Proves the refusal above comes from requireTLS, not from a server that cannot receive.
    const { service, smtp } = await setUp({ allowInsecureAuth: true, disabledCommands: ['STARTTLS'] });

    await service.sendMail(RECIPIENT, 'plaintext on purpose', {
      smtp: smtpOptions(smtp.port, { requireTLS: false }) as any,
      text: 'x',
    });
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0].session.secure).toBe(false);
  });
});
