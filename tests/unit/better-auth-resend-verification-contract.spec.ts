/**
 * Contract with the INSTALLED better-auth: `resendVerificationByToken()` delegates "does the account exist, and is
 * it unverified?" to Better-Auth's own `api.sendVerificationEmail`, so the ticket's abuse case "an already verified
 * account gets no mail" holds only as long as Better-Auth keeps that rule. The other resend specs replace Better-Auth
 * with a stub and the e2e configuration switches email verification off, so neither would notice an upgrade that
 * starts mailing verified or unknown accounts. This runs a real instance on the memory adapter.
 */
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';
import { sealVerificationToken } from '../../src/core/modules/better-auth/core-better-auth-verification-link.helper';

const SECRET = 'resend-contract-secret-4b7e1c9a2f6d0835';
const UNVERIFIED = 'unverified@test.com';
const VERIFIED = 'verified@test.com';
const UNKNOWN = 'unknown@test.com';

describe('resendVerificationByToken() against a real Better-Auth', () => {
  const mailed: string[] = [];
  const auth = betterAuth({
    basePath: '/iam',
    baseURL: 'http://localhost:3000',
    database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
    emailAndPassword: { enabled: true },
    emailVerification: {
      sendOnSignUp: false,
      sendVerificationEmail: async ({ user }) => {
        mailed.push(user.email);
      },
    },
    logger: { disabled: true },
    secret: SECRET,
  });
  const service = new CoreBetterAuthEmailVerificationService({ getFastButReadOnly: () => undefined } as never);

  const tokenFor = (email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));

  beforeAll(async () => {
    for (const email of [UNVERIFIED, VERIFIED]) {
      await auth.api.signUpEmail({ body: { email, name: 'Contract', password: 'Contract-Password-1' } });
    }
    await (await auth.$context).internalAdapter.updateUserByEmail(VERIFIED, { emailVerified: true });
    mailed.length = 0;
  });

  it('mails an unverified account once, to its own address', async () => {
    const answer = await service.resendVerificationByToken(auth, await tokenFor(UNVERIFIED), '203.0.113.10');

    expect(mailed).toEqual([UNVERIFIED]);
    expect(answer).toEqual({ email: 'u***@test.com', success: true });
  });

  it('mails neither a verified account nor an unknown address, with the same answer', async () => {
    mailed.length = 0;

    const verified = await service.resendVerificationByToken(auth, await tokenFor(VERIFIED), '203.0.113.11');
    const unknown = await service.resendVerificationByToken(auth, await tokenFor(UNKNOWN), '203.0.113.12');

    expect(mailed).toEqual([]);
    expect(verified).toEqual({ email: 'v***@test.com', success: true });
    expect(unknown).toEqual({ email: 'u***@test.com', success: true });
  });

  it('opens a sealed token against the same instance', async () => {
    mailed.length = 0;
    const sealed = await sealVerificationToken(SECRET, await tokenFor(UNVERIFIED));

    await service.resendVerificationByToken(auth, sealed, '203.0.113.13');

    expect(mailed).toEqual([UNVERIFIED]);
  });
});
