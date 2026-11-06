/**
 * `POST /iam/resend-verification-email` (DEV-4056): a new verification mail for the token of a verification link,
 * an expired one included, so the page can offer "send a new email" without the address ever being in a URL.
 *
 * What it must hold, case by case below:
 * - only a token with Better-Auth's signature reaches Better-Auth's `sendVerificationEmail`; a forged one, garbage
 *   and a token of an address change send nothing;
 * - the answer is the same whatever happened — the masked address of a validly signed token, `null` otherwise — and a
 *   failed send does not change it;
 * - per token and per client address the requests are limited, before the token is read, invalid tokens included.
 *
 * Better-Auth itself is replaced by its secret and a spy on `api.sendVerificationEmail`, which decides on its own
 * whether the account exists and is unverified. The e2e story covers the route against the assembled server.
 */
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';
import { sealVerificationToken } from '../../src/core/modules/better-auth/core-better-auth-verification-link.helper';

const SECRET = 'better-auth-test-secret-0123456789abcdef';
const EMAIL = 'kai@lenne.tech';

/** A verification token as Better-Auth's createEmailVerificationToken signs it (HS256, `{ email, updateTo?, userId }`) */
async function verificationToken(
  claims: Record<string, unknown>,
  options: { expiresInSeconds?: number; secret?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now - 7200)
    .setExpirationTime(now + (options.expiresInSeconds ?? 3600))
    .sign(new TextEncoder().encode(options.secret ?? SECRET));
}

function service(): CoreBetterAuthEmailVerificationService {
  return new CoreBetterAuthEmailVerificationService({ getFastButReadOnly: () => undefined } as never);
}

function betterAuth(send: (request: { body: { email: string } }) => Promise<unknown> = async () => ({ status: true })) {
  const sendVerificationEmail = vi.fn(send);
  return { instance: { $context: Promise.resolve({ secret: SECRET }), api: { sendVerificationEmail } }, sendVerificationEmail };
}

/** Counter stores of five keys each, so a test can fill them past capacity with a few hundred requests */
class SmallResendStores extends CoreBetterAuthEmailVerificationService {
  protected override readonly resendLimitStoreCapacity = 5;
}

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return (error as HttpException).getStatus();
  }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resendVerificationByToken() — who gets a new mail', () => {
  it('asks Better-Auth for a new mail to the address of a valid token, and answers it masked', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const token = await verificationToken({ email: EMAIL, userId: 'u1' });

    const answer = await service().resendVerificationByToken(instance, token, '203.0.113.1');

    expect(sendVerificationEmail).toHaveBeenCalledWith({ body: { email: EMAIL } });
    expect(answer).toEqual({ email: 'k***@lenne.tech', success: true });
  });

  it('opens the sealed token a link carries', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const sealed = await sealVerificationToken(SECRET, await verificationToken({ email: EMAIL, userId: 'u1' }));

    const answer = await service().resendVerificationByToken(instance, sealed, '203.0.113.1');

    expect(sendVerificationEmail).toHaveBeenCalledWith({ body: { email: EMAIL } });
    expect(answer.email).toBe('k***@lenne.tech');
  });

  it('sends nothing for a sealed token that does not open with this secret', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const sealed = await sealVerificationToken('another-secret-0123456789abcdef', await verificationToken({ email: EMAIL }));

    await expect(service().resendVerificationByToken(instance, sealed, '203.0.113.1')).resolves.toEqual({
      email: null,
      success: true,
    });
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('does the same for an expired token, which is what the endpoint is for', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const token = await verificationToken({ email: EMAIL, userId: 'u1' }, { expiresInSeconds: -60 });

    const answer = await service().resendVerificationByToken(instance, token, '203.0.113.1');

    expect(sendVerificationEmail).toHaveBeenCalledWith({ body: { email: EMAIL } });
    expect(answer.email).toBe('k***@lenne.tech');
  });

  /**
   * @regression   DEV-4056 — the endpoint mails the address IN the token. Read without checking Better-Auth's
   *   signature, anybody could have a verification mail sent to any address by encoding it into a token of their own.
   * @seen-failing Replace the signature check in readVerificationTokenClaims() by decoding the payload in
   *   src/core/modules/better-auth/core-better-auth-email-verification.service.ts — registered as mutation
   *   `resend-verification-trusts-unsigned-token` in tests/regression-mutations.json.
   */
  it('sends nothing for a token without Better-Auth signature, and answers without an address', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const forged = await verificationToken({ email: 'victim@example.com' }, { secret: 'not-the-secret-0123456789abcdef' });

    const answer = await service().resendVerificationByToken(instance, forged, '203.0.113.1');

    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(answer).toEqual({ email: null, success: true });
  });

  it.each([['garbage', 'not-a-token'], ['empty', ''], ['a number', 42], ['missing', undefined]])(
    'sends nothing for %s, and answers the same way',
    async (_label, token) => {
      const { instance, sendVerificationEmail } = betterAuth();

      const answer = await service().resendVerificationByToken(instance, token, '203.0.113.1');

      expect(sendVerificationEmail).not.toHaveBeenCalled();
      expect(answer).toEqual({ email: null, success: true });
    },
  );

  /**
   * @regression   DEV-4056 — a token of an address change (`updateTo`) belongs to a confirmation flow of its own. Sending
   *   a plain verification mail for its old address would verify the address the user is leaving.
   * @seen-failing Drop the `claims.updateTo` check in resendVerificationByToken() in
   *   src/core/modules/better-auth/core-better-auth-email-verification.service.ts — registered as mutation
   *   `resend-verification-for-email-change` in tests/regression-mutations.json.
   */
  it('sends nothing for the token of an address change, with the same answer', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const token = await verificationToken({ email: EMAIL, updateTo: 'new@lenne.tech' });

    const answer = await service().resendVerificationByToken(instance, token, '203.0.113.1');

    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(answer).toEqual({ email: 'k***@lenne.tech', success: true });
  });

  it('answers the same when Better-Auth refuses or fails to send', async () => {
    const { instance } = betterAuth(async () => {
      throw new Error("Verification email isn't enabled");
    });
    const token = await verificationToken({ email: EMAIL });

    await expect(service().resendVerificationByToken(instance, token, '203.0.113.1')).resolves.toEqual({
      email: 'k***@lenne.tech',
      success: true,
    });
  });

  it('answers without an address when Better-Auth is not running', async () => {
    const token = await verificationToken({ email: EMAIL });

    await expect(service().resendVerificationByToken(null, token, '203.0.113.1')).resolves.toEqual({
      email: null,
      success: true,
    });
  });
});

describe('resendVerificationByToken() — rate limits', () => {
  /**
   * @regression   DEV-4056 — without a limit per token, whoever holds one link can have the mailbox it names flooded
   *   (the per-address cooldown is per replica without Redis). Every valid link for one address counts together —
   *   sealed or plain, older or newer — so switching links does not multiply the limit.
   * @seen-failing Drop the per-token check in assertResendTokenLimit() in
   *   src/core/modules/better-auth/core-better-auth-email-verification.service.ts — registered as mutation
   *   `resend-verification-no-token-limit` in tests/regression-mutations.json.
   */
  it('refuses the fourth request with valid links for one address within the window, whichever link', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const verification = service();
    const plain = await verificationToken({ email: EMAIL });
    const sealed = await sealVerificationToken(SECRET, plain);
    const newerLink = await verificationToken({ email: EMAIL.toUpperCase() }, { expiresInSeconds: 7200 });
    for (const [attempt, token] of [plain, sealed, newerLink].entries()) {
      await verification.resendVerificationByToken(instance, token, `198.51.100.${attempt + 1}`);
    }

    expect(await statusOf(verification.resendVerificationByToken(instance, sealed, '198.51.100.9'))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(sendVerificationEmail).toHaveBeenCalledTimes(3);
  });

  /**
   * @regression   DEV-4056 release review — every request was counted under its token BEFORE the token was checked, in
   *   one store with the address counters. A store holds a fixed number of keys and folds the rest into 64 shared
   *   buckets, so about ten thousand junk tokens from one anonymous client put every real token into a bucket already
   *   past its limit: the resend answered 429 for every user while the flood went on. A real token must keep a counter
   *   of its own however much junk arrives — answered three times, refused the fourth.
   * @seen-failing Count the token before checking it again (call assertResendTokenLimit(tokenValue) first) in
   *   resendVerificationByToken() in src/core/modules/better-auth/core-better-auth-email-verification.service.ts —
   *   registered as mutation `resend-verification-junk-fills-token-counters`; and give both limits one store —
   *   mutation `resend-verification-limits-share-a-store`, both in tests/regression-mutations.json.
   */
  it('keeps its own counter for an expired sealed link after a flood of junk tokens', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const verification = new SmallResendStores({ getFastButReadOnly: () => undefined } as never);
    // Far past the capacity, each from its own address. Past capacity the address counters share overflow buckets, so
    // some junk requests are refused themselves; that is fine, only the real token's answer matters here
    for (let junk = 0; junk < 640; junk++) {
      await statusOf(verification.resendVerificationByToken(instance, `junk-token-${junk}`, `10.${junk >> 8}.${junk & 255}.1`));
    }
    // The case the endpoint exists for: the sealed link of a mail whose token has expired
    const expired = await sealVerificationToken(SECRET, await verificationToken({ email: EMAIL }, { expiresInSeconds: -60 }));

    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(verification.resendVerificationByToken(instance, expired, '203.0.113.50')).resolves.toEqual({
        email: 'k***@lenne.tech',
        success: true,
      });
    }
    expect(sendVerificationEmail).toHaveBeenCalledTimes(3);
    // Its own counter, not a shared overflow bucket (which would no longer refuse): the fourth is refused
    expect(await statusOf(verification.resendVerificationByToken(instance, expired, '203.0.113.50'))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  /**
   * @regression   DEV-4056 — the per-token limit alone lets one client try any number of different tokens.
   * @seen-failing Drop the per-address check in assertResendByTokenAllowed() in
   *   src/core/modules/better-auth/core-better-auth-email-verification.service.ts — registered as mutation
   *   `resend-verification-no-ip-limit` in tests/regression-mutations.json.
   */
  it('refuses the eleventh request from one client address within the window', async () => {
    const { instance } = betterAuth();
    const verification = service();
    for (let attempt = 1; attempt <= 10; attempt++) {
      await verification.resendVerificationByToken(instance, `token-${attempt}`, '192.0.2.7');
    }

    expect(await statusOf(verification.resendVerificationByToken(instance, 'token-11', '192.0.2.7'))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(await statusOf(verification.resendVerificationByToken(instance, 'token-12', '192.0.2.8'))).toBeUndefined();
  });

  /**
   * @regression   DEV-4056 review — behind a reverse proxy without `trustProxy` every client has the proxy's address.
   *   With valid tokens counted per address, ten junk requests from one anonymous caller locked the resend for every
   *   user of the deployment for the hour.
   * @seen-failing Count every request per address, not only invalid tokens (call assertResendAddressLimit() right after
   *   assertResendTokenLimit()) in src/core/modules/better-auth/core-better-auth-email-verification.service.ts —
   *   registered as mutation `resend-verification-ip-limit-counts-valid-tokens` in tests/regression-mutations.json.
   */
  it('does not count valid tokens per address, so junk from the same address cannot lock them out', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const verification = service();
    for (let attempt = 1; attempt <= 10; attempt++) {
      await verification.resendVerificationByToken(instance, `junk-${attempt}`, '10.0.0.1');
    }

    for (let user = 1; user <= 3; user++) {
      const token = await verificationToken({ email: `user${user}@lenne.tech` });
      await expect(verification.resendVerificationByToken(instance, token, '10.0.0.1')).resolves.toMatchObject({
        success: true,
      });
    }
    expect(sendVerificationEmail).toHaveBeenCalledTimes(3);
  });

  /**
   * @regression   DEV-4056 release review — valid tokens cost one sign-up each, so an attacker could sign up ten
   *   thousand addresses of their own, replay those links every hour and fill the store of valid-token counters: every
   *   other user's resend then landed in an overflow bucket past its limit and was refused.
   * @seen-failing Refuse a count from a shared overflow bucket again in assertResendTokenLimit() in
   *   src/core/modules/better-auth/core-better-auth-email-verification.service.ts — registered as mutation
   *   `resend-verification-overflow-refuses-valid-token` in tests/regression-mutations.json.
   */
  it('still answers a user whose counter only fits an overflow bucket after signed links filled the store', async () => {
    const { instance } = betterAuth();
    const verification = new SmallResendStores({ getFastButReadOnly: () => undefined } as never);
    // The attacker's own signed links, far past the capacity, so every overflow bucket is past the limit
    for (let other = 0; other < 640; other++) {
      const own = await verificationToken({ email: `catch-all-${other}@attacker.test` });
      await statusOf(verification.resendVerificationByToken(instance, own, '198.51.100.66'));
    }
    const expired = await sealVerificationToken(SECRET, await verificationToken({ email: EMAIL }, { expiresInSeconds: -60 }));

    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(verification.resendVerificationByToken(instance, expired, '203.0.113.51')).resolves.toEqual({
        email: 'k***@lenne.tech',
        success: true,
      });
    }
  });

  it('checks the limit before sending, so a refused request reaches Better-Auth not at all', async () => {
    const { instance, sendVerificationEmail } = betterAuth();
    const verification = service();
    const token = await verificationToken({ email: EMAIL });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await verification.resendVerificationByToken(instance, token, '203.0.113.5');
    }
    sendVerificationEmail.mockClear();

    await statusOf(verification.resendVerificationByToken(instance, token, '203.0.113.5'));

    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('maskEmailForDisplay()', () => {
  const mask = (email: string) => (service() as unknown as { maskEmailForDisplay(e: string): string }).maskEmailForDisplay(email);

  it.each([
    ['kai@lenne.tech', 'k***@lenne.tech'],
    ['a@b.de', 'a***@b.de'],
    ['first.last+tag@sub.example.com', 'f***@sub.example.com'],
  ])('%s -> %s', (email, masked) => {
    expect(mask(email)).toBe(masked);
  });

  it.each(['no-at-sign', '@example.com'])('hides an address it cannot split (%s) entirely', (email) => {
    expect(mask(email)).toBe('***');
  });
});
