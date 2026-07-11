/**
 * Regression: BetterAuth `advanced.useSecureCookies` default + override.
 *
 * Bug this guards against — a split-brain auth session:
 *   On an `https://` baseURL, Better-Auth auto-enables secure cookies and
 *   prefixes its session cookie with `__Secure-`. The nest-server cookie helpers
 *   however always write the UNPREFIXED `<cookiePrefix>.session_token`. Better-Auth's
 *   NATIVE handlers (2FA enable/disable, passkey register/list, backup codes,
 *   `/token`) then look for `__Secure-<cookiePrefix>.session_token` — a cookie that
 *   is never written — and answer `401 UNAUTHORIZED`, while `GET /iam/get-session`
 *   (which reads the unprefixed cookie) still returns `200`. To keep the native
 *   read path aligned with the cookie helper, `createBetterAuthInstance()` pins
 *   `advanced.useSecureCookies = false` by default. Consumers who manage cookies
 *   entirely through Better-Auth can re-enable it via
 *   `betterAuth.options.advanced.useSecureCookies` (deep-merged).
 *
 * These assertions read the ACTUAL config baked into the Better-Auth instance
 * (`instance.options.advanced`) — not a reimplementation of the merge — so a
 * change to the default or a regression in the `advanced` deep-merge fails here.
 *
 * The instance is built with a fake MongoDB `db`: `betterAuth()` only wraps the
 * adapter at construction time (no connection / no query), so no real Mongo is
 * needed and this stays a pure unit test.
 */

import { describe, expect, it } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';

// Minimal MongoDB `Db` stand-in. `mongodbAdapter(db)` only stores the reference;
// nothing here is called during `createBetterAuthInstance()`.
const fakeDb: any = {
  collection: () => ({
    createIndex: async () => undefined,
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';

/** Read back the `advanced` block Better-Auth was actually constructed with. */
function buildAdvanced(config: Record<string, unknown>): Record<string, any> {
  const result = createBetterAuthInstance({ config: config as any, db: fakeDb });
  expect(result).not.toBeNull();
  return (result!.instance as any).options.advanced as Record<string, any>;
}

describe('BetterAuth advanced.useSecureCookies', () => {
  // -------------------------------------------------------------------------
  // Default: pinned to false so the native handlers read the same (unprefixed)
  // cookie the nest-server cookie helper writes.
  // -------------------------------------------------------------------------

  it('defaults useSecureCookies to false (native handlers stay aligned with the cookie helper)', () => {
    const advanced = buildAdvanced({ enabled: true, secret: VALID_SECRET });

    expect(advanced.useSecureCookies).toBe(false);
    // cookiePrefix must always be present — it is the name the helper writes.
    expect(advanced.cookiePrefix).toBe('iam');
  });

  it('keeps the default false even on an https baseURL (the exact bug scenario)', () => {
    const advanced = buildAdvanced({
      baseUrl: 'https://api.example.com',
      enabled: true,
      secret: VALID_SECRET,
    });

    // Without the pin, an https baseURL is precisely what makes Better-Auth
    // flip secure cookies on and prefix the name with `__Secure-`.
    expect(advanced.useSecureCookies).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Override: a consumer that manages cookies entirely through Better-Auth can
  // re-enable secure cookies via options.advanced.useSecureCookies — and the
  // `advanced` deep-merge must keep cookiePrefix / crossSubDomainCookies intact.
  // -------------------------------------------------------------------------

  it('honours options.advanced.useSecureCookies: true (override wins)', () => {
    const advanced = buildAdvanced({
      enabled: true,
      options: { advanced: { useSecureCookies: true } },
      secret: VALID_SECRET,
    });

    expect(advanced.useSecureCookies).toBe(true);
    // Deep-merge intact: the framework-managed cookiePrefix survives the override.
    expect(advanced.cookiePrefix).toBe('iam');
  });

  it('preserves cookiePrefix AND crossSubDomainCookies when useSecureCookies is overridden', () => {
    const advanced = buildAdvanced({
      baseUrl: 'https://api.example.com',
      crossSubDomainCookies: true,
      enabled: true,
      options: { advanced: { useSecureCookies: true } },
      secret: VALID_SECRET,
    });

    // Override applied …
    expect(advanced.useSecureCookies).toBe(true);
    // … while every framework-set advanced key survives the deep-merge.
    expect(advanced.cookiePrefix).toBe('iam');
    expect(advanced.crossSubDomainCookies).toEqual({ domain: 'example.com', enabled: true });
  });

  // -------------------------------------------------------------------------
  // SEC-001 regression: `useSecureCookies: false` ALSO strips the `Secure`
  // attribute from every cookie Better-Auth sets, and its native handlers forward
  // their Set-Cookie VERBATIM (2FA verify, social callback, magic link, passkey)
  // without passing through the cookie helper — so those session cookies would
  // ship without `Secure` in production. `createBetterAuthInstance()` restores the
  // exact Secure flag Better-Auth would have derived (an https baseURL) via
  // `advanced.defaultCookieAttributes`, keeping the unprefixed NAME while
  // preserving the `Secure` TRANSPORT flag. Injected on https only, so http/local
  // and a consumer's own useSecureCookies override are left untouched.
  // -------------------------------------------------------------------------

  it('restores defaultCookieAttributes.secure=true on an https baseURL (SEC-001)', () => {
    const advanced = buildAdvanced({
      baseUrl: 'https://api.example.com',
      enabled: true,
      secret: VALID_SECRET,
    });

    // useSecureCookies stays false (keeps the unprefixed cookie name) …
    expect(advanced.useSecureCookies).toBe(false);
    // … but the Secure transport flag is restored for native-forwarded cookies.
    expect(advanced.defaultCookieAttributes).toEqual({ secure: true });
  });

  it('does not force secure on an http/localhost baseURL (http cookies must not carry Secure)', () => {
    const advanced = buildAdvanced({ enabled: true, secret: VALID_SECRET });

    // Default baseURL is http://localhost:3000 → Better-Auth itself would not set
    // Secure, so no override is injected.
    expect(advanced.useSecureCookies).toBe(false);
    expect(advanced.defaultCookieAttributes).toBeUndefined();
  });

  it('keeps defaultCookieAttributes.secure=true alongside a useSecureCookies override on https', () => {
    const advanced = buildAdvanced({
      baseUrl: 'https://api.example.com',
      enabled: true,
      options: { advanced: { useSecureCookies: true } },
      secret: VALID_SECRET,
    });

    // Consumer override wins for the prefix behavior …
    expect(advanced.useSecureCookies).toBe(true);
    // … and the framework's Secure restoration survives the deep-merge.
    expect(advanced.defaultCookieAttributes).toEqual({ secure: true });
  });
});
