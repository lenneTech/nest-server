import { describe, expect, it } from 'vitest';

import { getEnvironmentObject } from '../../src/core/common/helpers/config.helper';
import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';
import { captureExpectedLogs } from '../helpers/expected-log-output';

/**
 * Whether the options a project sets on a social provider reach Better-Auth.
 *
 * A provider is more than its credentials. Microsoft Entra ID needs `tenantId` to sign in through the customer's own
 * tenant instead of `common`, `disableDefaultScope` + `scope` to ask for `openid profile email` alone (the default adds
 * `User.Read` and `offline_access`, so a refresh token for Microsoft Graph lands in the `account` collection), and
 * `disableProfilePhoto` to skip a Graph call on every sign-in. Google has `hd`, `accessType` and `prompt`, Apple has
 * `appBundleIdentifier`, and so on.
 *
 * Until 12.10.0 `buildSocialProviders()` handed each provider `clientId`, `clientSecret` and `disableSignUp` and nothing
 * else. Everything above was dropped without a word, and the sign-in ran against `common`. The only way round was
 * `betterAuth.options.socialProviders`, which replaces the whole block: the provider then no longer appears in
 * `betterAuthFeatures.socialProviders`, and `emailAndPassword.disableSignUp` no longer closes it.
 *
 * The cases build the REAL `createBetterAuthInstance()` and read what Better-Auth itself was given; two of them run
 * Better-Auth's own `/sign-in/social` handler and read the authorization URL it answers with.
 */

/** Minimal MongoDB `Db` stand-in: lookups find nothing, writes succeed. */
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
const TENANT = '11111111-2222-3333-4444-555555555555';

const MICROSOFT = {
  clientId: 'microsoft-client-id',
  clientSecret: 'microsoft-client-secret',
  disableDefaultScope: true,
  disableProfilePhoto: true,
  scope: ['openid', 'profile', 'email'],
  tenantId: TENANT,
};

/** The Better-Auth instance for the given `betterAuth` configuration. */
function instanceFor(config: Record<string, unknown>): any {
  const result = createBetterAuthInstance({
    config: { enabled: true, secret: VALID_SECRET, ...config } as any,
    db: fakeDb,
  } as any);
  expect(result).not.toBeNull();
  return result!.instance;
}

/** The options Better-Auth holds for one provider. */
async function providerOptions(config: Record<string, unknown>, id: string): Promise<Record<string, unknown>> {
  const context = await instanceFor(config).$context;
  const provider = context.socialProviders.find((candidate: any) => candidate.id === id);
  expect(provider, `provider "${id}" is registered`).toBeDefined();
  return provider.options;
}

/** The authorization URL Better-Auth's own `/sign-in/social` answers with, without following it. */
async function authorizationUrl(config: Record<string, unknown>, body: Record<string, unknown>): Promise<URL> {
  const answer = await instanceFor(config).api.signInSocial({ body: { disableRedirect: true, ...body } });
  return new URL(answer.url);
}

describe('Better-Auth social provider options', () => {
  /**
   * @regression   12.10.0 — only `clientId`, `clientSecret` and `disableSignUp` reached a provider; `tenantId`, `scope`
   *   and every other option a project set were dropped, so Microsoft sign-in ran against `common`.
   * @seen-failing Leave the project's options out of the provider object again in buildSocialProviders()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-social-provider-options-dropped` in tests/regression-mutations.json.
   */
  it('hands a provider the options the project set on it', async () => {
    const options = await providerOptions({ socialProviders: { microsoft: MICROSOFT } }, 'microsoft');
    expect(options).toMatchObject({
      clientId: 'microsoft-client-id',
      clientSecret: 'microsoft-client-secret',
      disableDefaultScope: true,
      disableProfilePhoto: true,
      scope: ['openid', 'profile', 'email'],
      tenantId: TENANT,
    });
  });

  /**
   * @regression   12.10.0 — the same defect, seen from Better-Auth's own handler: the authorization URL pointed at
   *   `common` and asked for `User.Read` and `offline_access` although the project had configured its tenant and a
   *   reduced scope.
   * @seen-failing Leave the project's options out of the provider object again in buildSocialProviders()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-social-provider-options-dropped` in tests/regression-mutations.json.
   */
  it("signs in through the configured tenant with the configured scope in Better-Auth's own handler", async () => {
    const url = await authorizationUrl({ socialProviders: { microsoft: MICROSOFT } }, { provider: 'microsoft' });
    expect(`${url.origin}${url.pathname}`).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('client_id')).toBe('microsoft-client-id');
  });

  it('lets one request ask for a silent sign-in without changing the provider', async () => {
    const config = { socialProviders: { microsoft: MICROSOFT } };
    const silent = await authorizationUrl(config, { additionalParams: { prompt: 'none' }, provider: 'microsoft' });
    expect(silent.searchParams.get('prompt')).toBe('none');

    const interactive = await authorizationUrl(config, { provider: 'microsoft' });
    expect(interactive.searchParams.get('prompt')).toBeNull();
  });

  /**
   * @regression   12.10.0 — written together with the pass-through: spreading the project's object AFTER the computed
   *   `disableSignUp` hands Better-Auth the raw value again, and a string from `NEST_SERVER_CONFIG` opens a
   *   registration the project closed.
   * @seen-failing Spread the project's options last in buildSocialProviders()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `iam-social-provider-options-override-sign-up` in tests/regression-mutations.json.
   */
  it('keeps the sign-up decision when other options are passed through', async () => {
    const options = await providerOptions(
      {
        emailAndPassword: { disableSignUp: true },
        socialProviders: { microsoft: { ...MICROSOFT, disableSignUp: 'false' } },
      },
      'microsoft',
    );
    expect(options.disableSignUp).toBe(true);
    expect(options.tenantId).toBe(TENANT);
  });

  it('keeps `enabled` to itself', async () => {
    const options = await providerOptions(
      { socialProviders: { microsoft: { ...MICROSOFT, enabled: true } } },
      'microsoft',
    );
    expect(options).not.toHaveProperty('enabled');
  });

  /**
   * `scope` arrives as a string from an `NSC__*` variable: the reader converts only `true`, `false` and numbers, and
   * deployed starter projects configure everything that way. Better-Auth spreads `scope` into its list
   * (`scopes.push(...options.scope)`), so a string handed on unchanged became one scope per character.
   */
  it.each([
    ['space-separated string', 'openid profile email'],
    ['comma-separated string', 'openid,profile,email'],
    ['string with commas and spaces', ' openid, profile ,email '],
    ['list', ['openid', 'profile', 'email']],
  ])("asks for the configured scope when `scope` is a %s in Better-Auth's own handler", async (_form, scope) => {
    const url = await authorizationUrl(
      { socialProviders: { microsoft: { ...MICROSOFT, scope } } },
      { provider: 'microsoft' },
    );
    expect(url.searchParams.get('scope')).toBe('openid profile email');
  });

  it('signs in through the configured tenant when Microsoft is configured through NSC__ variables alone', async () => {
    const environment: any = getEnvironmentObject({
      processEnv: {
        NSC__BETTER_AUTH__SOCIAL_PROVIDERS__MICROSOFT__CLIENT_ID: 'microsoft-client-id',
        NSC__BETTER_AUTH__SOCIAL_PROVIDERS__MICROSOFT__CLIENT_SECRET: 'microsoft-client-secret',
        NSC__BETTER_AUTH__SOCIAL_PROVIDERS__MICROSOFT__DISABLE_DEFAULT_SCOPE: 'true',
        NSC__BETTER_AUTH__SOCIAL_PROVIDERS__MICROSOFT__DISABLE_PROFILE_PHOTO: 'true',
        NSC__BETTER_AUTH__SOCIAL_PROVIDERS__MICROSOFT__SCOPE: 'openid profile email',
        NSC__BETTER_AUTH__SOCIAL_PROVIDERS__MICROSOFT__TENANT_ID: TENANT,
      },
    });
    const config = { socialProviders: environment.betterAuth.socialProviders };

    expect(await providerOptions(config, 'microsoft')).toMatchObject({
      disableDefaultScope: true,
      disableProfilePhoto: true,
      scope: ['openid', 'profile', 'email'],
      tenantId: TENANT,
    });
    const url = await authorizationUrl(config, { provider: 'microsoft' });
    expect(`${url.origin}${url.pathname}`).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
  });

  /**
   * A `scope` that is neither a string nor a list cannot be split, and Better-Auth's `scopes.push(...options.scope)`
   * throws a `TypeError` on every `/sign-in/social` for an object. The index-keyed object is what `NSC__…__SCOPE__0`,
   * `__SCOPE__1` build; the number `0` is what an empty `NSC__…__SCOPE=` becomes. Both are dropped with one error, so the
   * provider signs in with its default scopes.
   */
  it.each([
    ['an index-keyed object', { 0: 'openid', 1: 'profile', 2: 'email' }, '{"0":"openid","1":"profile","2":"email"}'],
    ['a number', 0, '0'],
  ])('drops a `scope` that is %s, logs one error and still answers the sign-in', async (_form, scope, shown) => {
    const errors = captureExpectedLogs();
    const config = {
      socialProviders: {
        microsoft: {
          clientId: 'microsoft-client-id',
          clientSecret: 'microsoft-client-secret',
          scope,
          tenantId: TENANT,
        },
      },
    };

    expect(await providerOptions(config, 'microsoft')).not.toHaveProperty('scope');
    const scopeErrors = errors.filter((message) => message.includes('scope'));
    expect(scopeErrors).toHaveLength(1);
    expect(scopeErrors[0]).toContain('socialProviders.microsoft.scope');
    expect(scopeErrors[0]).toContain(shown);
    expect(scopeErrors[0]).toContain('comma- or space-separated string');
    expect(scopeErrors[0]).toContain('list');
    expect(scopeErrors[0]).not.toContain('disableDefaultScope');

    const url = await authorizationUrl(config, { provider: 'microsoft' });
    expect(url.searchParams.get('scope')).toBe('openid profile email User.Read offline_access');
  });

  it('says that the request carries no scope when `disableDefaultScope` is set beside a dropped `scope`', async () => {
    const errors = captureExpectedLogs();
    const config = { socialProviders: { microsoft: { ...MICROSOFT, scope: { 0: 'openid' } } } };

    const url = await authorizationUrl(config, { provider: 'microsoft' });
    expect(url.searchParams.has('scope')).toBe(false);

    const scopeErrors = errors.filter((message) => message.includes('scope'));
    expect(scopeErrors).toHaveLength(1);
    expect(scopeErrors[0]).toContain('disableDefaultScope');
    expect(scopeErrors[0]).toContain('no scope');
  });

  it('still registers a provider that sets nothing but its credentials', async () => {
    const options = await providerOptions(
      { socialProviders: { google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' } } },
      'google',
    );
    expect(options).toEqual({
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
      disableIdTokenSignIn: true,
      disableSignUp: false,
    });
  });
});
