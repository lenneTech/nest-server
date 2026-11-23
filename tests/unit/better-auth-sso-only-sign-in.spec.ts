import { Logger } from '@nestjs/common';
import { username } from 'better-auth/plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';
import {
  isSignInFactorEnabled,
  signInFactorsOffWithoutPassword,
} from '../../src/core/modules/better-auth/core-better-auth-sign-in-factors.helper';
import { CoreBetterAuthController } from '../../src/core/modules/better-auth/core-better-auth.controller';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

/**
 * Projects that sign in through a single sign-on provider alone (`emailAndPassword.enabled: false`, e.g. Microsoft
 * Entra) — DEV-4309, 12.11.0. The provider must decide who gets in: no sign-in method of the framework's own may keep
 * someone in after the provider withdrew the assignment or role.
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
const API = 'https://api.example.com';
const APP = 'https://app.example.com';
const SSO_ONLY = { emailAndPassword: { enabled: false } };
const GOOGLE = { clientId: 'google-client-id', clientSecret: 'google-client-secret' };
const MICROSOFT = { clientId: 'microsoft-client-id', clientSecret: 'microsoft-client-secret' };

function instanceFor(config: Record<string, unknown>): any {
  const result = createBetterAuthInstance({
    config: { enabled: true, secret: VALID_SECRET, ...config } as any,
    db: fakeDb,
    serverAppUrl: APP,
    serverBaseUrl: API,
    serverEnv: 'test',
  } as any);
  expect(result).not.toBeNull();
  return result!.instance;
}

async function pluginIds(config: Record<string, unknown>): Promise<string[]> {
  const context = await instanceFor(config).$context;
  return context.options.plugins.map((plugin: { id: string }) => plugin.id);
}

/** The status Better-Auth's own handler answers a passkey sign-in with. */
async function passkeySignInStatus(config: Record<string, unknown>): Promise<number> {
  const response: Response = await instanceFor(config).handler(
    new Request(`${API}/iam/passkey/verify-authentication`, {
      body: JSON.stringify({ response: {} }),
      headers: { 'content-type': 'application/json', origin: APP },
      method: 'POST',
    }),
  );
  return response.status;
}

function serviceFor(config: Record<string, unknown>): CoreBetterAuthService {
  return new CoreBetterAuthService({ options: {} } as any, null as any, { enabled: true, ...config } as any);
}

afterEach(() => vi.restoreAllMocks());

describe('Passkey and two-factor follow e-mail and password sign-in', () => {
  /**
   * @regression   12.11.0 — Passkey and two-factor stayed on with `emailAndPassword.enabled: false`: whoever registered
   *   a passkey after a provider sign-in kept signing in with it after the provider withdrew the assignment.
   * @seen-failing Switch a sign-in factor on whatever e-mail and password sign-in says in isSignInFactorEnabled()
   *   (src/core/modules/better-auth/core-better-auth-sign-in-factors.helper.ts) — registered as mutation
   *   `iam-sign-in-factors-ignore-password-off` in tests/regression-mutations.json.
   */
  it('registers neither plugin, and refuses a stored passkey, when e-mail and password sign-in is off', async () => {
    const ids = await pluginIds(SSO_ONLY);
    expect(ids).not.toContain('passkey');
    expect(ids).not.toContain('two-factor');
    expect(await passkeySignInStatus(SSO_ONLY)).toBe(404);

    const service = serviceFor(SSO_ONLY);
    expect(service.isPasskeyEnabled()).toBe(false);
    expect(service.isTwoFactorEnabled()).toBe(false);
  });

  it('keeps both on with e-mail and password sign-in, and on SSO-only only when switched on explicitly', async () => {
    expect(await pluginIds({})).toEqual(expect.arrayContaining(['passkey', 'two-factor']));
    expect(await passkeySignInStatus({})).not.toBe(404);

    const explicit = { ...SSO_ONLY, passkey: true, twoFactor: { appName: 'App', enabled: true } };
    expect(await pluginIds(explicit)).toEqual(expect.arrayContaining(['passkey', 'two-factor']));
    expect(serviceFor(explicit).isPasskeyEnabled()).toBe(true);
    expect(serviceFor(explicit).isTwoFactorEnabled()).toBe(true);
  });

  it('decides each value as documented', () => {
    for (const [value, config, expected] of [
      [undefined, {}, true],
      [{ appName: 'App' }, {}, true],
      [false, {}, false],
      [{ enabled: false }, {}, false],
      [undefined, SSO_ONLY, false],
      [{ appName: 'App' }, SSO_ONLY, false],
      [true, SSO_ONLY, true],
      [{ enabled: true }, SSO_ONLY, true],
      [{ enabled: false }, SSO_ONLY, false],
    ] as const) {
      expect(isSignInFactorEnabled(value, config as any), JSON.stringify({ config, value })).toBe(expected);
    }
    const names = (config: Record<string, unknown>) =>
      signInFactorsOffWithoutPassword(config as any).map((factor) => factor.name);
    expect(names(SSO_ONLY)).toEqual(['passkey', 'twoFactor']);
    expect(names({ ...SSO_ONLY, passkey: false })).toEqual(['twoFactor']);
    expect(names({})).toEqual([]);
  });

  it('names the factors it switched off once at boot, and warns for one that carried settings', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    instanceFor(SSO_ONLY);
    expect(log.mock.calls.map(([message]) => String(message)).join('\n')).toMatch(
      /passkey and twoFactor off: sign-in runs through a provider alone/,
    );
    instanceFor({ ...SSO_ONLY, twoFactor: { appName: 'App' } });
    expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toMatch(/twoFactor off/);
  });

  /**
   * @regression   12.11.0 (found in review) — e-mail and password sign-in off is not "provider alone" when a plugin adds
   *   a password sign-in of its own: the two-factor plugin is what enforces the second factor on `/sign-in/username` and
   *   `/sign-in/phone-number`, so switching it off let a leaked password sign in without the code.
   * @seen-failing Ignore the plugins' sign-in routes in isProviderOnlySignIn()
   *   (src/core/modules/better-auth/core-better-auth-sign-in-factors.helper.ts) — registered as mutation
   *   `iam-sign-in-factors-ignore-plugin-sign-in` in tests/regression-mutations.json.
   */
  it('keeps both on when a plugin of the project signs in with a password of its own', async () => {
    const withUsername = { ...SSO_ONLY, plugins: [username()], twoFactor: { appName: 'App' } };
    expect(await pluginIds(withUsername)).toEqual(expect.arrayContaining(['passkey', 'two-factor', 'username']));
    expect(serviceFor(withUsername).isTwoFactorEnabled()).toBe(true);
    expect(serviceFor(withUsername).isPasskeyEnabled()).toBe(true);
    expect(signInFactorsOffWithoutPassword(withUsername as any)).toEqual([]);
  });

  it('reports e-mail and password sign-in in GET /iam/features', () => {
    const features = (config: Record<string, unknown>) =>
      CoreBetterAuthController.prototype.getFeatures.call({ betterAuthService: serviceFor(config) } as any);
    expect(features({})).toMatchObject({ emailAndPassword: true, passkey: true, twoFactor: true });
    expect(features(SSO_ONLY)).toMatchObject({ emailAndPassword: false, passkey: false, twoFactor: false });
  });
});

describe('Sign-in with a client-submitted id token is closed by default', () => {
  /** What Better-Auth's own /sign-in/social handler answers a client-submitted id token with. */
  async function idTokenSignIn(google: Record<string, unknown>): Promise<string | undefined> {
    const instance = instanceFor({ socialProviders: { google } });
    const context = await instance.$context;
    const provider = context.socialProviders.find((entry: any) => entry.id === 'google');
    // Better-Auth's documented override of the id token check: a token that verifies, as a replayed one does
    provider.options.verifyIdToken = async () => true;
    provider.getUserInfo = async () => ({
      data: { sub: 'google-user-1' },
      user: { email: 'replayed@test.com', emailVerified: true, id: 'google-user-1', name: 'Replayed' },
    });
    try {
      await instance.api.signInSocial({ body: { idToken: { token: 'id-token' }, provider: 'google' } });
      return undefined;
    } catch (error: any) {
      return String(error?.body?.message ?? error?.message ?? '').toLowerCase();
    }
  }

  /**
   * @regression   12.11.0 — an id token kept from an earlier sign-in (`/iam/get-access-token` hands it out) signed its
   *   owner in again through `POST /iam/sign-in/social` for its whole lifetime, after the provider had withdrawn the
   *   assignment or role; Better-Auth checks such a token's signature, audience and expiry and asks the provider nothing.
   * @seen-failing Open the id token sign-in unless a project closes it in buildSocialProviders()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation `iam-id-token-sign-in-open-by-default`
   *   in tests/regression-mutations.json.
   */
  it('refuses a client-submitted id token unless the project opens it with false', async () => {
    expect(await idTokenSignIn(GOOGLE)).toBe('id_token not supported');
    expect(await idTokenSignIn({ ...GOOGLE, disableIdTokenSignIn: false })).not.toBe('id_token not supported');
    // Only `false` opens it — a string from NEST_SERVER_CONFIG does not
    expect(await idTokenSignIn({ ...GOOGLE, disableIdTokenSignIn: 'false' })).toBe('id_token not supported');

    // Every provider is closed, Microsoft included; the redirect flow is untouched
    const context = await instanceFor({ socialProviders: { google: GOOGLE, microsoft: MICROSOFT } }).$context;
    for (const id of ['google', 'microsoft']) {
      expect(context.socialProviders.find((entry: any) => entry.id === id).options.disableIdTokenSignIn).toBe(true);
    }
  });
});

describe('betterAuth.session: a fixed session lifetime', () => {
  async function sessionOptions(config: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    return (await instanceFor(config).$context).options.session;
  }

  it('hands Better-Auth the lifetime in seconds and switches the extension off with extendOnUse: false', async () => {
    expect(await sessionOptions({ session: { expiresInHours: 8, extendOnUse: false } })).toMatchObject({
      disableSessionRefresh: true,
      expiresIn: 8 * 3600,
    });
    expect(await sessionOptions({ session: { expiresInHours: 24 } })).toEqual({ expiresIn: 24 * 3600 });
    expect(await sessionOptions({})).toBeUndefined();
  });

  it("keeps a project's options.session next to it, and lets it win key by key", async () => {
    expect(
      await sessionOptions({
        options: { session: { cookieCache: { enabled: true }, expiresIn: 3600 } },
        session: { expiresInHours: 8, extendOnUse: false },
      }),
    ).toEqual({ cookieCache: { enabled: true }, disableSessionRefresh: true, expiresIn: 3600 });
  });

  it('ignores a lifetime that is not a positive number, with a warning, and keeps the default', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const expiresInHours of [0, -1, Number.NaN, '8']) {
      expect(await sessionOptions({ session: { expiresInHours } })).toBeUndefined();
    }
    expect(warn.mock.calls.filter(([message]) => String(message).includes('expiresInHours'))).toHaveLength(4);
  });
});
