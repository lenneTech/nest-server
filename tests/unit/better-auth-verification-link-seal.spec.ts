/**
 * The verification link carries Better-Auth's token SEALED (DEV-4056, core-better-auth-verification-link.helper.ts).
 *
 * Better-Auth's token is a signed, readable JWT: `{ email, userId, iat, exp }` in base64url. Dropping `&email=` from
 * the link alone left the address in every URL the link reached — mail, browser history, access logs. These cases pin
 * that no segment of the link reveals the address, that the seal opens only with the secret it was made with, that a
 * plain token from an older mail still goes through, and that the module's mail callback actually seals what it
 * hands to the mailer. The e2e story proves the opening in the API middleware against the assembled server.
 */
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoreBetterAuthModule } from '../../src/core/modules/better-auth/core-better-auth.module';
import {
  isSealedVerificationToken,
  openVerificationToken,
  sealVerificationToken,
} from '../../src/core/modules/better-auth/core-better-auth-verification-link.helper';

const SECRET = 'better-auth-test-secret-0123456789abcdef';
const EMAIL = 'alice.smith@example.com';

async function betterAuthToken(): Promise<string> {
  return new SignJWT({ email: EMAIL, userId: '665f0c2e8b1a4d0012345678' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));
}

/** Everything a reader of the link can decode: every dot-separated segment, base64url-decoded */
function decodableText(value: string): string {
  return value
    .split('.')
    .map((segment) => Buffer.from(segment, 'base64url').toString('latin1'))
    .join(' ');
}

describe('sealVerificationToken() / openVerificationToken()', () => {
  it('the plain Better-Auth token reveals the address — the reason the seal exists', async () => {
    expect(decodableText(await betterAuthToken())).toContain(EMAIL);
  });

  it('seals into a value whose segments reveal neither the address nor the user id', async () => {
    const sealed = await sealVerificationToken(SECRET, await betterAuthToken());

    expect(isSealedVerificationToken(sealed)).toBe(true);
    expect(decodableText(sealed)).not.toContain(EMAIL);
    expect(decodableText(sealed)).not.toContain('665f0c2e8b1a4d0012345678');
  });

  it('opens with the same secret to exactly the token Better-Auth signed', async () => {
    const token = await betterAuthToken();

    expect(await openVerificationToken(SECRET, await sealVerificationToken(SECRET, token))).toBe(token);
  });

  it('does not open with another secret, nor a garbled seal', async () => {
    const sealed = await sealVerificationToken(SECRET, await betterAuthToken());

    expect(await openVerificationToken('another-secret-0123456789abcdef', sealed)).toBeUndefined();
    expect(await openVerificationToken(SECRET, `${sealed.slice(0, -4)}AAAA`)).toBeUndefined();
  });

  it('lets the plain token of a link mailed before the seal through unchanged', async () => {
    const token = await betterAuthToken();

    expect(isSealedVerificationToken(token)).toBe(false);
    expect(await openVerificationToken(SECRET, token)).toBe(token);
  });
});

describe("CoreBetterAuthModule's verification-mail callback", () => {
  const moduleState = CoreBetterAuthModule as unknown as {
    authInstance: unknown;
    emailVerificationService: unknown;
  };
  const saved = { authInstance: moduleState.authInstance, emailVerificationService: moduleState.emailVerificationService };

  afterEach(() => {
    moduleState.authInstance = saved.authInstance;
    moduleState.emailVerificationService = saved.emailVerificationService;
  });

  /**
   * @regression   DEV-4056 review — the link no longer carried `&email=`, but Better-Auth's token in it is a readable
   *   JWT with the address and the user id. Every URL the link reached still disclosed both.
   * @seen-failing Hand the options to sendVerificationEmail() without sealVerificationMail() in
   *   createEmailVerificationCallbacks() in src/core/modules/better-auth/core-better-auth.module.ts — registered as
   *   mutation `verification-link-token-readable` in tests/regression-mutations.json.
   */
  it('hands the mailer a sealed token and a link that reveals no address', async () => {
    const sendVerificationEmail = vi.fn(async () => undefined);
    moduleState.emailVerificationService = { sendVerificationEmail };
    moduleState.authInstance = { $context: Promise.resolve({ secret: SECRET }) };
    const token = await betterAuthToken();
    const url = `http://localhost:3000/iam/verify-email?token=${token}&callbackURL=%2F`;

    const callbacks = (
      CoreBetterAuthModule as unknown as {
        createEmailVerificationCallbacks(): { sendVerificationEmail(options: unknown): Promise<void> };
      }
    ).createEmailVerificationCallbacks();
    await callbacks.sendVerificationEmail({ token, url, user: { email: EMAIL, id: 'u1', name: 'Alice' } });

    const [[options]] = sendVerificationEmail.mock.calls as unknown as [[{ token: string; url: string }]];
    expect(isSealedVerificationToken(options.token)).toBe(true);
    expect(await openVerificationToken(SECRET, options.token)).toBe(token);
    expect(options.url).toContain(options.token);
    expect(options.url).not.toContain(token);
    expect(decodableText(new URL(options.url).searchParams.get('token') ?? '')).not.toContain(EMAIL);
  });
});
