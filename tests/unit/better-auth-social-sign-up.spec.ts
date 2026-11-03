import { describe, expect, it } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';

/**
 * Whether a first sign-in through a social provider creates an account while sign-up is switched off.
 *
 * `betterAuth.emailAndPassword.disableSignUp: true` is how a project closes self-registration (accounts only through an
 * admin or an invitation). Better-Auth reads that flag for `/sign-up/email` only; for a social provider it decides per
 * provider (`provider.options.disableSignUp`, in the OAuth callback and in `/sign-in/social` with an `idToken`). Until
 * 12.3.0 the framework passed only `clientId` and `clientSecret` to each provider, so anybody signing in with Google for
 * the first time got an account in a project that had closed registration.
 *
 * Since 12.3.0 the global flag closes every path, and `socialProviders.<name>.disableSignUp` is the deliberate exception
 * per provider (`false` opens it, `true` closes only that one). Only a boolean counts there: a value that arrived as a
 * string through `NEST_SERVER_CONFIG` must not open a closed registration.
 *
 * The cases build the REAL `createBetterAuthInstance()` and read what Better-Auth itself was given, and one of them runs
 * Better-Auth's own `/sign-in/social` handler for an unknown user, so a hand copy of the rule cannot pass for it.
 */

/** Minimal MongoDB `Db` stand-in: every lookup finds nothing, so an OAuth sign-in reaches the "new user" branch. */
const fakeDb: any = {
  collection: () => ({
    aggregate: () => ({ toArray: async () => [] }),
    createIndex: async () => undefined,
    find: () => {
      const cursor: any = { limit: () => cursor, skip: () => cursor, sort: () => cursor, toArray: async () => [] };
      return cursor;
    },
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';

const GOOGLE = { clientId: 'google-client-id', clientSecret: 'google-client-secret' };
const GITHUB = { clientId: 'github-client-id', clientSecret: 'github-client-secret' };

/** The Better-Auth instance for the given `betterAuth` configuration. */
function instanceFor(config: Record<string, unknown>): any {
  const result = createBetterAuthInstance({
    config: { enabled: true, secret: VALID_SECRET, ...config } as any,
    db: fakeDb,
  } as any);
  expect(result).not.toBeNull();
  return result!.instance;
}

/** `disableSignUp` per provider id, as Better-Auth's context holds it */
async function signUpClosedPerProvider(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const context = await instanceFor(config).$context;
  return Object.fromEntries(
    context.socialProviders.map((provider: any) => [provider.id, provider.options?.disableSignUp]),
  );
}

/**
 * Runs Better-Auth's `/sign-in/social` with an `idToken` for a user nobody knows yet, and returns the error message it
 * answered with (`undefined` when it answered without error). The provider's token check and profile lookup are
 * replaced on the context's provider object, so the decision about the new account is Better-Auth's own.
 */
async function firstSocialSignIn(config: Record<string, unknown>): Promise<string | undefined> {
  const instance = instanceFor(config);
  const context = await instance.$context;
  const google = context.socialProviders.find((provider: any) => provider.id === 'google');
  // Better-Auth's documented override of the id_token check (`supportsIdTokenSignIn()` / `verifyProviderIdToken()`)
  google.options.verifyIdToken = async () => true;
  google.getUserInfo = async () => ({
    data: { sub: 'google-user-1' },
    user: { email: 'new-social-user@test.com', emailVerified: true, id: 'google-user-1', name: 'New User' },
  });
  try {
    await instance.api.signInSocial({ body: { idToken: { token: 'id-token' }, provider: 'google' } });
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('Better-Auth social sign-up while sign-up is switched off', () => {
  /**
   * @regression   12.3.0 — `emailAndPassword.disableSignUp: true` closed `/sign-up/email` only; a first sign-in through
   *   a social provider still created an account, because each provider got only `clientId` and `clientSecret`.
   * @seen-failing Pass only `clientId` and `clientSecret` to each provider again in buildSocialProviders()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-social-sign-up-ignores-disable-sign-up` in tests/regression-mutations.json.
   */
  it('closes every configured provider when sign-up is switched off', async () => {
    const closed = await signUpClosedPerProvider({
      emailAndPassword: { disableSignUp: true },
      socialProviders: { github: GITHUB, google: GOOGLE },
    });
    expect(closed).toEqual({ github: true, google: true });
  });

  /**
   * @regression   12.3.0 — the same defect, seen from Better-Auth's own handler: an unknown user got an account.
   * @seen-failing Pass only `clientId` and `clientSecret` to each provider again in buildSocialProviders()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-social-sign-up-ignores-disable-sign-up` in tests/regression-mutations.json.
   */
  it("refuses the account in Better-Auth's own /sign-in/social handler", async () => {
    const refused = await firstSocialSignIn({
      emailAndPassword: { disableSignUp: true },
      socialProviders: { google: GOOGLE },
    });
    expect(refused).toBe('signup disabled');

    // The counter-check: with sign-up open, the same request is not refused for that reason
    const open = await firstSocialSignIn({ socialProviders: { google: GOOGLE } });
    expect(open).not.toBe('signup disabled');
  });

  it('keeps every provider open while sign-up is open', async () => {
    expect(await signUpClosedPerProvider({ socialProviders: { github: GITHUB, google: GOOGLE } })).toEqual({
      github: false,
      google: false,
    });
    expect(
      await signUpClosedPerProvider({
        emailAndPassword: { disableSignUp: false },
        socialProviders: { google: GOOGLE },
      }),
    ).toEqual({ google: false });
  });

  it('lets a provider open sign-up deliberately with disableSignUp: false', async () => {
    const closed = await signUpClosedPerProvider({
      emailAndPassword: { disableSignUp: true },
      socialProviders: { github: GITHUB, google: { ...GOOGLE, disableSignUp: false } },
    });
    expect(closed).toEqual({ github: true, google: false });
  });

  it('lets a provider close sign-up on its own with disableSignUp: true', async () => {
    const closed = await signUpClosedPerProvider({
      socialProviders: { github: GITHUB, google: { ...GOOGLE, disableSignUp: true } },
    });
    expect(closed).toEqual({ github: false, google: true });
  });

  /**
   * @regression   12.3.0 — only a boolean per-provider value counts; passed through as it came (`?? global`), it hands
   *   Better-Auth a non-boolean, and a falsy one (`0`, an empty string from `NEST_SERVER_CONFIG`) opens a registration
   *   the project closed.
   * @seen-failing Pass the per-provider value through with `?? signUpClosed` in buildSocialProviders()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-social-sign-up-string-opens` in tests/regression-mutations.json.
   */
  it('does not let a non-boolean per-provider value open a closed registration', async () => {
    const closed = await signUpClosedPerProvider({
      emailAndPassword: { disableSignUp: true },
      socialProviders: { github: { ...GITHUB, disableSignUp: 'false' }, google: { ...GOOGLE, disableSignUp: 0 } },
    });
    expect(closed).toEqual({ github: true, google: true });

    const emptyString = await signUpClosedPerProvider({
      emailAndPassword: { disableSignUp: true },
      socialProviders: { google: { ...GOOGLE, disableSignUp: '' } },
    });
    expect(emptyString).toEqual({ google: true });
  });
});
