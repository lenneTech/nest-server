import { describe, expect, it } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';
import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';

/**
 * Whether `GET /iam/verify-email` signs in the browser that opens the link.
 *
 * Signing in on verification signs that browser in to the account the link belongs to — whoever opens it. Someone who
 * signs up with their own address and forwards the unopened link has the recipient's browser signed in to their
 * account, and what the recipient then enters lands there (login CSRF / session planting). Better-Auth's own default is
 * therefore `false`, and since 12.3.0 (11.46.0 on 11.x) the framework's is too; a project that wants the convenience opts in.
 *
 * The cases read the option off the REAL `createBetterAuthInstance()` result, so a change to the default in the config
 * builder cannot hide behind a hand copy of it.
 */

/** Minimal MongoDB `Db` stand-in — `mongodbAdapter(db)` only stores the reference. */
const fakeDb: any = {
  collection: () => ({
    createIndex: async () => undefined,
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';

/** The `emailVerification` options Better-Auth was actually constructed with. */
function verificationOptions(emailVerification?: unknown): Record<string, any> {
  const result = createBetterAuthInstance({
    config: {
      enabled: true,
      secret: VALID_SECRET,
      ...(emailVerification === undefined ? {} : { emailVerification }),
    } as any,
    db: fakeDb,
    sendVerificationEmail: async () => undefined,
  } as any);
  expect(result).not.toBeNull();
  return (result!.instance as any).options.emailVerification as Record<string, any>;
}

/** The verification service as the module builds it, for the given `betterAuth.emailVerification` value. */
function verificationService(emailVerification: unknown): CoreBetterAuthEmailVerificationService {
  const configService = {
    getFastButReadOnly: (key: string) => (key === 'betterAuth.emailVerification' ? emailVerification : undefined),
  } as any;
  return new CoreBetterAuthEmailVerificationService(configService);
}

describe('Better-Auth auto sign-in after e-mail verification', () => {
  /**
   * @regression   11.46.0 (12.3.0 backport) — `autoSignInAfterVerification` defaulted to `true` (Better-Auth's own default is `false`), so
   *   every project with e-mail verification signed in whoever opened a forwarded verification link, to the account of
   *   the link's owner.
   * @seen-failing Default `autoSignInAfterVerification` to `true` again in buildEmailVerificationConfig()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-auto-sign-in-after-verification-default-on` in tests/regression-mutations.json.
   */
  it('is off without configuration, as Better-Auth has it', () => {
    expect(verificationOptions().autoSignInAfterVerification).toBe(false);
    expect(verificationOptions(true).autoSignInAfterVerification).toBe(false);
    expect(verificationOptions({ locale: 'de' }).autoSignInAfterVerification).toBe(false);
  });

  it('is on when the project switches it on explicitly', () => {
    expect(verificationOptions({ autoSignInAfterVerification: true }).autoSignInAfterVerification).toBe(true);
  });

  it('stays off for an explicit false', () => {
    expect(verificationOptions({ autoSignInAfterVerification: false }).autoSignInAfterVerification).toBe(false);
  });

  /**
   * @regression   11.46.0 (12.3.0 backport) — the verification service reported the old default as well.
   * @seen-failing Default `autoSignInAfterVerification` to `true` again in DEFAULT_CONFIG
   *   (src/core/modules/better-auth/core-better-auth-email-verification.service.ts) — registered as mutation
   *   `iam-auto-sign-in-service-default-on` in tests/regression-mutations.json.
   */
  it('is reported as off by the verification service unless switched on', () => {
    expect(verificationService(undefined).shouldAutoSignIn()).toBe(false);
    expect(verificationService(true).shouldAutoSignIn()).toBe(false);
    expect(verificationService({ locale: 'de' }).shouldAutoSignIn()).toBe(false);
    expect(verificationService({ autoSignInAfterVerification: true }).shouldAutoSignIn()).toBe(true);
  });

  /**
   * @regression   11.46.0 (12.3.0 backport) — the service returned the merged value as it came, so a string in `NEST_SERVER_CONFIG`
   *   reported a sign-in that Better-Auth (which receives `=== true`) never performs.
   * @seen-failing Return the raw value in shouldAutoSignIn()
   *   (src/core/modules/better-auth/core-better-auth-email-verification.service.ts) — registered as mutation
   *   `iam-auto-sign-in-service-truthy` in tests/regression-mutations.json.
   */
  it('reads a non-boolean value as off, in both places alike', () => {
    expect(verificationOptions({ autoSignInAfterVerification: 'true' }).autoSignInAfterVerification).toBe(false);
    expect(verificationService({ autoSignInAfterVerification: 'true' }).shouldAutoSignIn()).toBe(false);
  });
});
