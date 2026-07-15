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

import { getCookies } from 'better-auth/cookies';
import { describe, expect, it } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';
import { sendWebResponse } from '../../src/core/modules/better-auth/core-better-auth-web.helper';

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

/**
 * The assertions above prove our CONFIG carries `defaultCookieAttributes: { secure: true }`.
 * They do NOT prove Better-Auth honours it — and that distinction is the whole ballgame.
 *
 * Better-Auth derives every cookie in `createCookieGetter()` (better-auth/dist/cookies/index.mjs):
 *
 *   attributes: {
 *     secure: !!secureCookiePrefix,                  // false — because we pin useSecureCookies: false
 *     …
 *     ...options.advanced?.defaultCookieAttributes,  // { secure: true } — spread AFTER, so it wins
 *     …
 *   }
 *
 * The Secure flag on production session cookies therefore rests entirely on that SPREAD ORDER,
 * inside a third-party library, and nothing in this repo pinned it. If a Better-Auth upgrade moved
 * `defaultCookieAttributes` above the `secure:` line — or stopped applying it to the session cookie —
 * the config-shape tests above would stay green while every session cookie from the NATIVE-forwarded
 * path (2FA verify, social callback, magic link, passkey) silently shipped over HTTPS without
 * `Secure`. Session-establishing flows, transmitted in the clear on any downgraded request.
 *
 * So these tests call Better-Auth's OWN `getCookies()` — the exact function its handlers use — on
 * the ACTUAL options of a constructed instance, and assert the DERIVED attributes. This is a guard
 * against the library, not against ourselves.
 */
describe('BetterAuth session cookie: attributes Better-Auth actually derives', () => {
  /** Build a real instance, then ask Better-Auth what session cookie it would emit. */
  function derivedSessionCookie(config: Record<string, unknown>) {
    const result = createBetterAuthInstance({ config: config as any, db: fakeDb });
    expect(result).not.toBeNull();
    return getCookies((result!.instance as any).options).sessionToken;
  }

  it('emits Secure=true AND an unprefixed name on an https baseURL', () => {
    const sessionToken = derivedSessionCookie({
      baseUrl: 'https://api.example.com',
      enabled: true,
      secret: VALID_SECRET,
    });

    // The transport flag — without this, native-forwarded session cookies go out in the clear.
    expect(sessionToken.attributes.secure).toBe(true);

    // …while the NAME stays unprefixed. Both must hold at once: a `__Secure-` prefix here would
    // resurrect the 401 split-brain (native handlers reading a cookie the helper never writes).
    expect(sessionToken.name).toBe('iam.session_token');
    expect(sessionToken.name).not.toContain('__Secure-');

    // Defense in depth: these should never regress either.
    expect(sessionToken.attributes.httpOnly).toBe(true);
    expect(sessionToken.attributes.sameSite.toLowerCase()).toBe('lax');
  });

  it('does NOT set Secure on an http baseURL (would break local dev — browsers drop Secure cookies on http)', () => {
    const sessionToken = derivedSessionCookie({ enabled: true, secret: VALID_SECRET });

    expect(sessionToken.attributes.secure).toBe(false);
    expect(sessionToken.name).toBe('iam.session_token');
  });

  it('still emits Secure=true when a consumer overrides useSecureCookies on https', () => {
    const sessionToken = derivedSessionCookie({
      baseUrl: 'https://api.example.com',
      enabled: true,
      options: { advanced: { useSecureCookies: true } },
      secret: VALID_SECRET,
    });

    expect(sessionToken.attributes.secure).toBe(true);
    // Consumer opted into Better-Auth managing cookies entirely → the __Secure- prefix is expected.
    expect(sessionToken.name).toBe('__Secure-iam.session_token');
  });

  // ---------------------------------------------------------------------------------------------
  // The framework's Secure restoration lives INSIDE the `defaultCookieAttributes` key. A shallow
  // spread of a consumer's `options.advanced` therefore let them replace that whole object — and a
  // consumer setting it for a completely unrelated reason (cookie partitioning, a custom domain)
  // silently dropped `Secure` from every native-forwarded session cookie on https. The merge is now
  // deep for that one key: `secure: true` is the base, consumer keys spread over it.
  // ---------------------------------------------------------------------------------------------

  it('keeps Secure when a consumer sets an UNRELATED defaultCookieAttributes key on https', () => {
    const sessionToken = derivedSessionCookie({
      baseUrl: 'https://api.example.com',
      enabled: true,
      options: { advanced: { defaultCookieAttributes: { partitioned: true } } },
      secret: VALID_SECRET,
    });

    // The consumer's key is honoured …
    expect((sessionToken.attributes as Record<string, unknown>).partitioned).toBe(true);
    // … and Secure survives. Before the deep merge this was `false` — session cookies in the clear.
    expect(sessionToken.attributes.secure).toBe(true);
  });

  it('lets an EXPLICIT secure:false override win (deliberate opt-out is still the consumer’s call)', () => {
    const sessionToken = derivedSessionCookie({
      baseUrl: 'https://api.example.com',
      enabled: true,
      options: { advanced: { defaultCookieAttributes: { secure: false } } },
      secret: VALID_SECRET,
    });

    // Explicit beats implicit: we protect against silent clobbering, not against an informed choice.
    expect(sessionToken.attributes.secure).toBe(false);
  });
});

/**
 * The last link in the chain.
 *
 * The tests above prove Better-Auth DERIVES a session cookie carrying `Secure`. They do not prove it
 * reaches the wire. Session-establishing flows that Better-Auth handles NATIVELY — 2FA verify,
 * social callback, magic link, passkey — never pass through `BetterAuthCookieHelper`; their
 * `Set-Cookie` is forwarded by our own `sendWebResponse()`. That helper is exactly the link a prior
 * security review accused of dropping the `Secure` attribute.
 *
 * So: derivation (`getCookies`, above) → forwarding (`sendWebResponse`, here) → wire. Both halves
 * are now pinned, and the accusation is refuted at the precise point it was aimed.
 */
describe('sendWebResponse: native-forwarded Set-Cookie reaches Express verbatim', () => {
  /** Minimal Express `Response` stand-in — only what sendWebResponse touches. */
  function fakeExpressRes() {
    const headers: Record<string, unknown> = {};
    return {
      end: () => undefined,
      getHeader: (name: string) => headers[name.toLowerCase()],
      headers,
      send: () => undefined,
      setHeader: (name: string, value: unknown) => {
        headers[name.toLowerCase()] = value;
      },
      status: () => undefined,
    } as any;
  }

  it('preserves the Secure attribute on a natively-forwarded session cookie', async () => {
    const cookie = 'iam.session_token=abc123; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax';
    const webResponse = new Response(null, { headers: { 'set-cookie': cookie }, status: 200 });
    const res = fakeExpressRes();

    await sendWebResponse(res, webResponse);

    const forwarded = res.getHeader('set-cookie') as string[];
    expect(forwarded).toContain(cookie);
    // The whole point: the attribute survives the hop into Express untouched.
    expect(forwarded.join('; ')).toContain('Secure');
  });

  it('does not drop cookies that were already set before the native handler ran', async () => {
    const preExisting = 'compat.token=xyz; Path=/';
    const fromBetterAuth = 'iam.session_token=abc123; Path=/; HttpOnly; Secure; SameSite=Lax';

    const res = fakeExpressRes();
    res.setHeader('set-cookie', [preExisting]);

    await sendWebResponse(res, new Response(null, { headers: { 'set-cookie': fromBetterAuth }, status: 200 }));

    const forwarded = res.getHeader('set-cookie') as string[];
    expect(forwarded).toContain(preExisting);
    expect(forwarded).toContain(fromBetterAuth);
  });
});
