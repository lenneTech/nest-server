/**
 * Unit Tests: Cookie/JWT Configuration Modes + CORS Config
 *
 * Tests all 4 cookie/JWT configuration modes and the unified CORS config:
 * 1. JWT-only (cookies: false) — token in body, no cookies
 * 2. Cookie-only (cookies: true, default) — no token in body, cookies set
 * 3. Hybrid with token (cookies: { exposeTokenInBody: true }) — token in body AND cookies
 * 4. Hybrid without token (cookies: true, no exposeTokenInBody) — same as cookie-only
 *
 * Also tests CORS config resolution and BetterAuth trustedOrigins propagation.
 */

import { describe, expect, it } from 'vitest';

import {
  assertCookiesProductionSafe,
  buildCorsConfig,
  deriveAppUrlFromBaseUrl,
  getDefaultAuthCookieOptions,
  isCookiesEnabled,
  isCorsDisabled,
  isExposeTokenInBodyEnabled,
  isProductionLikeEnv,
  resolveServerUrls,
  setLegacyAuthCookies,
  shouldConvertSessionTokenToJwt,
} from '../../src/core/common/helpers/cookies.helper';
import { BetterAuthCookieHelper } from '../../src/core/modules/better-auth/core-better-auth-cookie.helper';

// =================================================================================================
// Cookie Configuration Helper Tests
// =================================================================================================

describe('Cookie Configuration: isCookiesEnabled', () => {
  it('should be enabled by default (undefined)', () => {
    expect(isCookiesEnabled(undefined)).toBe(true);
  });

  it('should be enabled when true', () => {
    expect(isCookiesEnabled(true)).toBe(true);
  });

  it('should be disabled when false', () => {
    expect(isCookiesEnabled(false)).toBe(false);
  });

  it('should be enabled when empty object (Boolean Shorthand)', () => {
    expect(isCookiesEnabled({})).toBe(true);
  });

  it('should be enabled when object with enabled: true', () => {
    expect(isCookiesEnabled({ enabled: true })).toBe(true);
  });

  it('should be disabled when object with enabled: false', () => {
    expect(isCookiesEnabled({ enabled: false })).toBe(false);
  });

  it('should be enabled when object with exposeTokenInBody only', () => {
    expect(isCookiesEnabled({ exposeTokenInBody: true })).toBe(true);
  });

  it('should handle null gracefully (treated as enabled like undefined)', () => {
    expect(isCookiesEnabled(null as any)).toBe(true);
  });
});

describe('Cookie Configuration: isExposeTokenInBodyEnabled', () => {
  it('should be false by default (undefined)', () => {
    expect(isExposeTokenInBodyEnabled(undefined)).toBe(false);
  });

  it('should be false when true (Boolean Shorthand)', () => {
    expect(isExposeTokenInBodyEnabled(true)).toBe(false);
  });

  it('should be false when false', () => {
    expect(isExposeTokenInBodyEnabled(false)).toBe(false);
  });

  it('should be false when empty object', () => {
    expect(isExposeTokenInBodyEnabled({})).toBe(false);
  });

  it('should be true when exposeTokenInBody: true', () => {
    expect(isExposeTokenInBodyEnabled({ exposeTokenInBody: true })).toBe(true);
  });

  it('should be false when exposeTokenInBody: false', () => {
    expect(isExposeTokenInBodyEnabled({ exposeTokenInBody: false })).toBe(false);
  });
});

// =================================================================================================
// processAuthResult Token Handling Tests
// =================================================================================================

describe('processAuthResult: Token handling per configuration', () => {
  const createHelper = () =>
    new BetterAuthCookieHelper({
      basePath: '/iam',
      legacyCookieEnabled: false,
    });

  const mockRes = () => {
    const cookies: Record<string, unknown> = {};
    return {
      cookie: (name: string, value: unknown, _opts?: unknown) => {
        cookies[name] = value;
      },
      getCookies: () => cookies,
    } as any;
  };

  it('Case 1: JWT-only (cookies: false) — token stays in body', () => {
    const helper = createHelper();
    const res = mockRes();
    const result = { session: { id: 'sess1' }, token: 'my-token' };

    helper.processAuthResult(res, result, false);

    expect(result.token).toBe('my-token');
    expect(res.getCookies()).toEqual({});
  });

  it('Case 2: Cookie-only (cookies: true, default) — token removed from body, cookie set with token value', () => {
    const helper = createHelper();
    const res = mockRes();
    const result = { session: { id: 'sess1' }, token: 'my-token' };

    helper.processAuthResult(res, result, true, false);

    expect(result.token).toBeUndefined();
    // Helper was constructed without secret → cookie value equals the raw token
    expect(res.getCookies()['iam.session_token']).toBe('my-token');
  });

  it('Case 3: Hybrid with token (exposeTokenInBody: true) — token in body AND cookie set with token value', () => {
    const helper = createHelper();
    const res = mockRes();
    const result = { session: { id: 'sess1' }, token: 'my-token' };

    helper.processAuthResult(res, result, true, true);

    expect(result.token).toBe('my-token');
    expect(res.getCookies()['iam.session_token']).toBe('my-token');
  });

  it('Case 4: Hybrid without token (cookies: true, exposeTokenInBody: false) — same as cookie-only', () => {
    const helper = createHelper();
    const res = mockRes();
    const result = { session: { id: 'sess1' }, token: 'my-token' };

    helper.processAuthResult(res, result, true, false);

    expect(result.token).toBeUndefined();
    expect(res.getCookies()['iam.session_token']).toBe('my-token');
  });

  it('should not set cookies or modify token when cookiesEnabled is false', () => {
    const helper = createHelper();
    const res = mockRes();
    const result = { session: { id: 'sess1' }, token: 'jwt-token-value' };

    helper.processAuthResult(res, result, false, true);

    // Even with exposeTokenInBody: true, if cookies are disabled, nothing happens
    expect(result.token).toBe('jwt-token-value');
    expect(res.getCookies()).toEqual({});
  });

  it('should handle result without token property (session-only) gracefully', () => {
    const helper = createHelper();
    const res = mockRes();
    // Session-only result (e.g. token already retrieved elsewhere)
    const result = { session: { id: 'sess1' } } as { session: { id: string }; token?: string };

    // Must not throw
    expect(() => helper.processAuthResult(res, result, true, false)).not.toThrow();

    // No token was set because result.token was absent
    expect(result.token).toBeUndefined();
    expect(res.getCookies()).toEqual({});
  });
});

describe('CORS Configuration: isCorsDisabled', () => {
  it('should not be disabled by default (undefined)', () => {
    expect(isCorsDisabled(undefined)).toBe(false);
  });

  it('should not be disabled when true', () => {
    expect(isCorsDisabled(true)).toBe(false);
  });

  it('should be disabled when false', () => {
    expect(isCorsDisabled(false)).toBe(true);
  });

  it('should not be disabled when empty object', () => {
    expect(isCorsDisabled({})).toBe(false);
  });

  it('should be disabled when enabled: false', () => {
    expect(isCorsDisabled({ enabled: false })).toBe(true);
  });

  it('should not be disabled when enabled: true', () => {
    expect(isCorsDisabled({ enabled: true })).toBe(false);
  });
});

// =================================================================================================
// CORS Config Resolution Tests
// =================================================================================================

describe('CORS Configuration: buildCorsConfig', () => {
  it('should return empty object when cors is false', () => {
    expect(buildCorsConfig({ cors: false })).toEqual({});
  });

  it('should return empty object when cors.enabled is false', () => {
    expect(buildCorsConfig({ cors: { enabled: false } })).toEqual({});
  });

  it('should return empty object when cookies are false', () => {
    expect(buildCorsConfig({ cookies: false })).toEqual({});
  });

  it('should return origin: true when allowAll is true', () => {
    expect(buildCorsConfig({ cors: { allowAll: true } })).toEqual({
      credentials: true,
      origin: true,
    });
  });

  it('should use appUrl and baseUrl as origins', () => {
    const result = buildCorsConfig({
      appUrl: 'https://example.com',
      baseUrl: 'https://api.example.com',
    });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://example.com', 'https://api.example.com'],
    });
  });

  it('should merge allowedOrigins with appUrl/baseUrl', () => {
    const result = buildCorsConfig({
      appUrl: 'https://example.com',
      baseUrl: 'https://api.example.com',
      cors: { allowedOrigins: ['https://admin.example.com'] },
    });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://example.com', 'https://api.example.com', 'https://admin.example.com'],
    });
  });

  it('should deduplicate origins', () => {
    const result = buildCorsConfig({
      appUrl: 'https://example.com',
      cors: { allowedOrigins: ['https://example.com', 'https://admin.example.com'] },
    });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://example.com', 'https://admin.example.com'],
    });
  });

  it('should return empty object when no origins are configured (secure default)', () => {
    // Security fix v11.25.0: never return { origin: true } as the "nothing configured"
    // fallback — that would silently allow open CORS with credentials.
    expect(buildCorsConfig({})).toEqual({});
  });

  it('should return empty object when cors is undefined and no urls', () => {
    expect(buildCorsConfig({ cors: undefined })).toEqual({});
  });

  it('should return empty object when cookies are disabled via object shorthand', () => {
    expect(buildCorsConfig({ cookies: { enabled: false }, cors: { allowAll: true } })).toEqual({});
  });

  it('should handle cors: true (Boolean Shorthand) — falls through to no-origins case', () => {
    // cors: true is treated like cors: {} — no allowAll, no allowedOrigins, so the
    // no-origins secure default applies (returns {}).
    expect(buildCorsConfig({ cors: true })).toEqual({});
  });

  it('should handle cors: true with appUrl → uses appUrl as origin', () => {
    expect(buildCorsConfig({ appUrl: 'https://example.com', cors: true })).toEqual({
      credentials: true,
      origin: ['https://example.com'],
    });
  });

  // Regression: deployed configs typically set only baseUrl (NSC__BASE_URL) and rely on
  // appUrl being auto-derived from it (api.example.com → example.com). Both this layer and
  // BetterAuth's resolveUrls() now share resolveServerUrls(), so they cannot drift. Without
  // the derivation, the REST CORS layer only allowed the API origin and blocked the frontend
  // app origin — breaking every api.<host> / <host> deployment out of the box.
  it('should derive appUrl from baseUrl when appUrl is not set (api.* → apex)', () => {
    const result = buildCorsConfig({ baseUrl: 'https://api.example.com' });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://example.com', 'https://api.example.com'],
    });
  });

  it('should still merge allowedOrigins with the derived appUrl', () => {
    const result = buildCorsConfig({
      baseUrl: 'https://api.example.com',
      cors: { allowedOrigins: ['https://admin.example.com'] },
    });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://example.com', 'https://api.example.com', 'https://admin.example.com'],
    });
  });

  it('should NOT override an explicit appUrl with a derived one', () => {
    const result = buildCorsConfig({
      appUrl: 'https://app.other-domain.com',
      baseUrl: 'https://api.example.com',
    });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://app.other-domain.com', 'https://api.example.com'],
    });
  });

  it('should not add a duplicate origin when baseUrl has no api. prefix', () => {
    const result = buildCorsConfig({ baseUrl: 'https://example.com' });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://example.com'],
    });
  });

  // Opt-out: deriving the apex grants it credentialed CORS. Deployments whose apex is not
  // trusted (third-party-hosted marketing site) must be able to keep it out of the allowlist.
  it('should not derive appUrl when cors.deriveAppUrl is false', () => {
    const result = buildCorsConfig({
      baseUrl: 'https://api.example.com',
      cors: { deriveAppUrl: false },
    });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://api.example.com'],
    });
  });

  it('should still honor an explicit appUrl when cors.deriveAppUrl is false', () => {
    const result = buildCorsConfig({
      appUrl: 'https://app.example.com',
      baseUrl: 'https://api.example.com',
      cors: { deriveAppUrl: false },
    });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://app.example.com', 'https://api.example.com'],
    });
  });

  // Normalization: the browser's Origin header is always a bare origin, so a trailing slash
  // would produce an entry that can never match — and would defeat the dedup.
  it('should normalize a trailing-slash baseUrl to its origin and deduplicate', () => {
    const result = buildCorsConfig({ baseUrl: 'https://example.com/' });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://example.com'],
    });
  });

  it('should normalize a trailing-slash api baseUrl on both derived and raw entries', () => {
    const result = buildCorsConfig({ baseUrl: 'https://api.example.com/' });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://example.com', 'https://api.example.com'],
    });
  });

  // Security: `URL.origin` serializes to the literal string 'null' for opaque origins, which
  // is exactly the Origin header a sandboxed iframe sends. It must never reach the allowlist.
  it('should never emit the string "null" as an origin for a non-http(s) baseUrl', () => {
    const result = buildCorsConfig({ baseUrl: 'custom://api.example.com' });
    expect(result.origin).not.toContain('null');
    expect(result.origin).toEqual(['custom://api.example.com']);
  });

  // Localhost defaults: API on :3000, app on :3001. Previously only BetterAuth applied these,
  // so the REST/GraphQL CORS layer blocked the frontend in local/ci/e2e.
  it.each(['ci', 'e2e', 'local'])('should apply localhost defaults for env: %s', (env) => {
    expect(buildCorsConfig({ env })).toEqual({
      credentials: true,
      origin: ['http://localhost:3001', 'http://localhost:3000'],
    });
  });

  it('should apply the localhost app default when baseUrl is localhost (not derive :3000)', () => {
    const result = buildCorsConfig({ baseUrl: 'http://localhost:3000', env: 'e2e' });
    expect(result).toEqual({
      credentials: true,
      origin: ['http://localhost:3001', 'http://localhost:3000'],
    });
  });

  // `lt dev up` serves API and app as sibling *.localhost hosts behind Caddy. The allowlist
  // must contain the app host, not the flat localhost:3001 default.
  it('should allow the sibling app host for a host-split localhost baseUrl', () => {
    const result = buildCorsConfig({ baseUrl: 'https://api.crm.localhost', env: 'local' });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://crm.localhost', 'https://api.crm.localhost'],
    });
  });

  it('should allow the sibling app host on a non-default port', () => {
    const result = buildCorsConfig({ baseUrl: 'https://api.crm.localhost:8443', env: 'local' });
    expect(result).toEqual({
      credentials: true,
      origin: ['https://crm.localhost:8443', 'https://api.crm.localhost:8443'],
    });
  });

  // `api.localhost` is the flat port split — the app lives on :3001, not on the default port.
  it('should keep the localhost app default when the api. label strips to bare localhost', () => {
    const result = buildCorsConfig({ baseUrl: 'https://api.localhost', env: 'local' });
    expect(result).toEqual({
      credentials: true,
      origin: ['http://localhost:3001', 'https://api.localhost'],
    });
  });

  it('should NOT apply localhost defaults for non-localhost environments', () => {
    expect(buildCorsConfig({ env: 'development' })).toEqual({});
    expect(buildCorsConfig({ env: 'production' })).toEqual({});
  });
});

// =================================================================================================
// Server URL Resolution Tests (shared by CORS and BetterAuth)
// =================================================================================================

describe('URL Resolution: deriveAppUrlFromBaseUrl', () => {
  it('should strip the api. label from a multi-label hostname', () => {
    expect(deriveAppUrlFromBaseUrl('https://api.example.com')).toBe('https://example.com');
  });

  it('should strip only the leading api. label from a nested subdomain', () => {
    expect(deriveAppUrlFromBaseUrl('https://api.dev.example.com')).toBe('https://dev.example.com');
  });

  it('should preserve a non-default port', () => {
    expect(deriveAppUrlFromBaseUrl('https://api.example.com:8443')).toBe('https://example.com:8443');
    expect(deriveAppUrlFromBaseUrl('https://api.crm.localhost:8443')).toBe('https://crm.localhost:8443');
  });

  it('should strip api. in front of localhost (lt dev: api.<slug>.localhost)', () => {
    expect(deriveAppUrlFromBaseUrl('http://api.localhost:3000')).toBe('http://localhost:3000');
    expect(deriveAppUrlFromBaseUrl('https://api.nest-server.localhost')).toBe('https://nest-server.localhost');
  });

  it('should return the origin unchanged when there is no api. prefix', () => {
    expect(deriveAppUrlFromBaseUrl('https://example.com')).toBe('https://example.com');
    expect(deriveAppUrlFromBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('should normalize away a trailing slash', () => {
    expect(deriveAppUrlFromBaseUrl('https://api.example.com/')).toBe('https://example.com');
  });

  it('should lowercase the hostname (Origin headers are lowercase)', () => {
    expect(deriveAppUrlFromBaseUrl('https://API.Example.COM')).toBe('https://example.com');
  });

  // `api.dev`, `api.io`, `api.co` are registrable domains. Stripping would hand a bare TLD
  // ('https://dev') to the CORS allowlist — an unreachable host masking a broken config.
  it('should NOT strip when only a bare TLD would remain', () => {
    expect(deriveAppUrlFromBaseUrl('https://api.dev')).toBe('https://api.dev');
    expect(deriveAppUrlFromBaseUrl('https://api.io')).toBe('https://api.io');
  });

  it('should NOT strip when nothing would remain', () => {
    expect(deriveAppUrlFromBaseUrl('https://api.')).toBe('https://api.');
  });

  it('should return non-http(s) input verbatim instead of the opaque "null" origin', () => {
    expect(deriveAppUrlFromBaseUrl('custom://api.example.com')).toBe('custom://api.example.com');
  });

  it('should return unparsable input verbatim', () => {
    expect(deriveAppUrlFromBaseUrl('api.example.com')).toBe('api.example.com');
    expect(deriveAppUrlFromBaseUrl('')).toBe('');
  });
});

describe('URL Resolution: resolveServerUrls', () => {
  it('should mark an explicit appUrl as explicit and never derive over it', () => {
    expect(resolveServerUrls({ appUrl: 'https://app.other.com', baseUrl: 'https://api.example.com' })).toEqual({
      appUrl: 'https://app.other.com',
      appUrlSource: 'explicit',
      baseUrl: 'https://api.example.com',
      baseUrlSource: 'explicit',
    });
  });

  it('should derive appUrl from baseUrl', () => {
    expect(resolveServerUrls({ baseUrl: 'https://api.example.com' })).toEqual({
      appUrl: 'https://example.com',
      appUrlSource: 'derived',
      baseUrl: 'https://api.example.com',
      baseUrlSource: 'explicit',
    });
  });

  it('should skip derivation when deriveAppUrl is false', () => {
    expect(resolveServerUrls({ baseUrl: 'https://api.example.com', deriveAppUrl: false })).toEqual({
      appUrl: undefined,
      appUrlSource: 'none',
      baseUrl: 'https://api.example.com',
      baseUrlSource: 'explicit',
    });
  });

  it('should apply localhost defaults for local/ci/e2e when nothing is configured', () => {
    expect(resolveServerUrls({ env: 'e2e' })).toEqual({
      appUrl: 'http://localhost:3001',
      appUrlSource: 'localhost-default',
      baseUrl: 'http://localhost:3000',
      baseUrlSource: 'localhost-default',
    });
  });

  it('should prefer the localhost app default over deriving from a localhost baseUrl', () => {
    const result = resolveServerUrls({ baseUrl: 'http://127.0.0.1:3000', env: 'local' });
    expect(result.appUrl).toBe('http://localhost:3001');
    expect(result.appUrlSource).toBe('localhost-default');
  });

  // The localhost defaults encode a PORT split (API :3000, app :3001, one host). `lt dev up`
  // instead serves a HOST split behind Caddy — `https://api.<slug>.localhost` next to
  // `https://<slug>.localhost` — where the flat :3001 default names a host the app never
  // serves from. The derivation has to win there.
  it.each(['ci', 'e2e', 'local'])('should derive the app origin from a host-split localhost baseUrl (%s)', (env) => {
    const result = resolveServerUrls({ baseUrl: 'https://api.crm.localhost', env });
    expect(result.appUrl).toBe('https://crm.localhost');
    expect(result.appUrlSource).toBe('derived');
  });

  it('should derive across a nested host-split localhost baseUrl', () => {
    const result = resolveServerUrls({ baseUrl: 'https://api.nest-server.localhost', env: 'local' });
    expect(result.appUrl).toBe('https://nest-server.localhost');
    expect(result.appUrlSource).toBe('derived');
  });

  // A host split stays a host split behind a non-default port — Caddy may serve `lt dev` on
  // something other than :443. Keying the decision on the port would send this back to the flat
  // `http://localhost:3001` default and block the frontend by preflight.
  it('should derive from a host-split localhost baseUrl on a non-default port', () => {
    const result = resolveServerUrls({ baseUrl: 'https://api.crm.localhost:8443', env: 'local' });
    expect(result.appUrl).toBe('https://crm.localhost:8443');
    expect(result.appUrlSource).toBe('derived');
  });

  // `api.localhost` strips to the bare `localhost` the API already answers on, so only the port
  // tells app and API apart — that is the flat port split the localhost defaults describe.
  it('should keep the localhost app default when the api. label strips to bare localhost', () => {
    for (const baseUrl of ['http://api.localhost:3000', 'https://api.localhost', 'http://api.localhost']) {
      const result = resolveServerUrls({ baseUrl, env: 'local' });
      expect(result.appUrl).toBe('http://localhost:3001');
      expect(result.appUrlSource).toBe('localhost-default');
    }
  });

  // deriveAppUrl only governs the api.-strip derivation; the localhost defaults are an
  // explicit, documented behavior of the local/ci/e2e environments.
  it('should still apply localhost defaults when deriveAppUrl is false', () => {
    const result = resolveServerUrls({ deriveAppUrl: false, env: 'ci' });
    expect(result.appUrl).toBe('http://localhost:3001');
    expect(result.appUrlSource).toBe('localhost-default');
  });

  it('should fall back to the localhost default when deriveAppUrl is false on a host split', () => {
    const result = resolveServerUrls({ baseUrl: 'https://api.crm.localhost', deriveAppUrl: false, env: 'local' });
    expect(result.appUrl).toBe('http://localhost:3001');
    expect(result.appUrlSource).toBe('localhost-default');
  });

  it('should not apply localhost defaults for other environments', () => {
    expect(resolveServerUrls({ env: 'development' })).toEqual({
      appUrl: undefined,
      appUrlSource: 'none',
      baseUrl: undefined,
      baseUrlSource: 'none',
    });
  });

  it('should not treat a lookalike host as localhost', () => {
    const result = resolveServerUrls({ baseUrl: 'https://api.not-localhost.com', env: 'local' });
    expect(result.appUrl).toBe('https://not-localhost.com');
    expect(result.appUrlSource).toBe('derived');
  });
});

// =================================================================================================
// setLegacyAuthCookies Tests (Legacy Auth: token + refreshToken cookies)
// =================================================================================================

describe('setLegacyAuthCookies', () => {
  const mockRes = () => {
    const cookies: Record<string, { options: unknown; value: unknown }> = {};
    return {
      cookie: (name: string, value: unknown, options?: unknown) => {
        cookies[name] = { options, value };
      },
      getCookies: () => cookies,
    } as any;
  };

  it('should set secure cookie defaults (httpOnly, sameSite=lax, secure=false in test env)', () => {
    const res = mockRes();
    setLegacyAuthCookies(res, { refreshToken: 'r1', token: 't1' }, true);

    const tokenCookie = res.getCookies()['token'];
    // In test env (NODE_ENV !== 'production'), secure is false
    expect(tokenCookie.options).toEqual({ httpOnly: true, sameSite: 'lax', secure: false });
  });

  it('should set secure: true when env is production', () => {
    const res = mockRes();
    setLegacyAuthCookies(res, { refreshToken: 'r1', token: 't1' }, true, 'production');

    const tokenCookie = res.getCookies()['token'];
    expect(tokenCookie.options).toEqual({ httpOnly: true, sameSite: 'lax', secure: true });
  });

  it('should set secure: true when env is staging (covers SEC-001)', () => {
    const res = mockRes();
    setLegacyAuthCookies(res, { refreshToken: 'r1', token: 't1' }, true, 'staging');

    const tokenCookie = res.getCookies()['token'];
    expect(tokenCookie.options).toEqual({ httpOnly: true, sameSite: 'lax', secure: true });
  });

  it('should skip cookie setting when cookies are disabled', () => {
    const res = mockRes();
    const result = setLegacyAuthCookies(res, { refreshToken: 'r1', token: 't1' }, false);

    expect(res.getCookies()).toEqual({});
    expect(result?.token).toBe('t1');
    expect(result?.refreshToken).toBe('r1');
  });

  it('should remove tokens from body by default (cookies enabled, no exposeTokenInBody)', () => {
    const res = mockRes();
    const result = setLegacyAuthCookies(res, { refreshToken: 'r1', token: 't1' }, true);

    expect(result?.token).toBeUndefined();
    expect(result?.refreshToken).toBeUndefined();
    expect(res.getCookies()['token'].value).toBe('t1');
    expect(res.getCookies()['refreshToken'].value).toBe('r1');
  });

  it('should keep tokens in body when exposeTokenInBody: true', () => {
    const res = mockRes();
    const result = setLegacyAuthCookies(res, { refreshToken: 'r1', token: 't1' }, { exposeTokenInBody: true });

    expect(result?.token).toBe('t1');
    expect(result?.refreshToken).toBe('r1');
    expect(res.getCookies()['token'].value).toBe('t1');
  });

  it('should clear cookies when result is null/undefined (logout path)', () => {
    const res = mockRes();
    setLegacyAuthCookies(res, null, true);

    expect(res.getCookies()['token'].value).toBe('');
    expect(res.getCookies()['refreshToken'].value).toBe('');
  });
});

// =================================================================================================
// Production Safety Guard Tests
// =================================================================================================

describe('assertCookiesProductionSafe', () => {
  it('should throw when exposeTokenInBody: true in production', () => {
    expect(() => assertCookiesProductionSafe({ exposeTokenInBody: true }, 'production')).toThrow(
      /must not be true in production or staging/,
    );
  });

  it('should throw when exposeTokenInBody: true in staging', () => {
    expect(() => assertCookiesProductionSafe({ exposeTokenInBody: true }, 'staging')).toThrow(
      /must not be true in production or staging/,
    );
  });

  it('should allow exposeTokenInBody: true in ci', () => {
    expect(() => assertCookiesProductionSafe({ exposeTokenInBody: true }, 'ci')).not.toThrow();
  });

  it('should allow exposeTokenInBody: true in e2e', () => {
    expect(() => assertCookiesProductionSafe({ exposeTokenInBody: true }, 'e2e')).not.toThrow();
  });

  it('should allow exposeTokenInBody: true in development', () => {
    expect(() => assertCookiesProductionSafe({ exposeTokenInBody: true }, 'development')).not.toThrow();
  });

  it('should allow exposeTokenInBody: true in local', () => {
    expect(() => assertCookiesProductionSafe({ exposeTokenInBody: true }, 'local')).not.toThrow();
  });

  it('should allow exposeTokenInBody: false in production', () => {
    expect(() => assertCookiesProductionSafe({ exposeTokenInBody: false }, 'production')).not.toThrow();
  });

  it('should allow undefined cookies config in production', () => {
    expect(() => assertCookiesProductionSafe(undefined, 'production')).not.toThrow();
  });

  it('should allow cookies: true (Boolean Shorthand) in production', () => {
    expect(() => assertCookiesProductionSafe(true, 'production')).not.toThrow();
  });

  it('should allow cookies: false in production', () => {
    expect(() => assertCookiesProductionSafe(false, 'production')).not.toThrow();
  });
});

// =================================================================================================
// isProductionLikeEnv Tests
// =================================================================================================

describe('isProductionLikeEnv', () => {
  it('should be true for production env', () => {
    expect(isProductionLikeEnv('production')).toBe(true);
  });

  it('should be true for staging env', () => {
    expect(isProductionLikeEnv('staging')).toBe(true);
  });

  it('should fall back to NODE_ENV when env is undefined', () => {
    // NODE_ENV in tests is never 'production' — result depends on captured env at import time
    // The function must NOT throw and must return a boolean.
    expect(typeof isProductionLikeEnv(undefined)).toBe('boolean');
  });

  it('should be false for dev/ci/e2e/local when NODE_ENV is not production', () => {
    expect(isProductionLikeEnv('development')).toBe(false);
    expect(isProductionLikeEnv('ci')).toBe(false);
    expect(isProductionLikeEnv('e2e')).toBe(false);
    expect(isProductionLikeEnv('local')).toBe(false);
  });
});

// =================================================================================================
// getDefaultAuthCookieOptions Tests (env-aware secure flag)
// =================================================================================================

describe('getDefaultAuthCookieOptions', () => {
  it('should set secure: true when env is production', () => {
    expect(getDefaultAuthCookieOptions('production')).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
  });

  it('should set secure: true when env is staging', () => {
    expect(getDefaultAuthCookieOptions('staging')).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
  });

  it('should set secure: false when env is dev/ci/e2e/local', () => {
    for (const env of ['development', 'ci', 'e2e', 'local']) {
      const opts = getDefaultAuthCookieOptions(env);
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('lax');
      // Secure is false in these envs unless NODE_ENV === 'production' (not the case in tests)
      expect(opts.secure).toBe(false);
    }
  });

  it('should always set httpOnly: true and sameSite: lax regardless of env', () => {
    const opts = getDefaultAuthCookieOptions(undefined);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
  });
});

// =================================================================================================
// shouldConvertSessionTokenToJwt Tests (hybrid mode decision logic)
// =================================================================================================

describe('shouldConvertSessionTokenToJwt', () => {
  // Mode 1: JWT-only (cookies: false)
  it('should convert in JWT-only mode (cookies: false, jwt enabled)', () => {
    expect(shouldConvertSessionTokenToJwt(false, true)).toBe(true);
  });

  // Mode 2: Cookie-only (cookies: true, default)
  it('should NOT convert in cookie-only mode (cookies: true, jwt enabled)', () => {
    expect(shouldConvertSessionTokenToJwt(true, true)).toBe(false);
  });

  it('should NOT convert in cookie-only mode (cookies: undefined, jwt enabled)', () => {
    expect(shouldConvertSessionTokenToJwt(undefined, true)).toBe(false);
  });

  it('should NOT convert in cookie-only mode (cookies: {}, jwt enabled)', () => {
    expect(shouldConvertSessionTokenToJwt({}, true)).toBe(false);
  });

  // Mode 3: Hybrid (cookies: { exposeTokenInBody: true })
  it('should convert in hybrid mode (exposeTokenInBody: true, jwt enabled)', () => {
    expect(shouldConvertSessionTokenToJwt({ exposeTokenInBody: true }, true)).toBe(true);
  });

  it('should convert in hybrid mode (enabled: true + exposeTokenInBody: true)', () => {
    expect(shouldConvertSessionTokenToJwt({ enabled: true, exposeTokenInBody: true }, true)).toBe(true);
  });

  // JWT plugin disabled → never convert
  it('should NOT convert when jwt plugin is disabled (cookies: false)', () => {
    expect(shouldConvertSessionTokenToJwt(false, false)).toBe(false);
  });

  it('should NOT convert when jwt plugin is disabled (cookies: true)', () => {
    expect(shouldConvertSessionTokenToJwt(true, false)).toBe(false);
  });

  it('should NOT convert when jwt plugin is disabled (hybrid mode)', () => {
    expect(shouldConvertSessionTokenToJwt({ exposeTokenInBody: true }, false)).toBe(false);
  });

  // Edge: cookies disabled via object shorthand
  it('should convert when cookies disabled via { enabled: false }', () => {
    expect(shouldConvertSessionTokenToJwt({ enabled: false }, true)).toBe(true);
  });
});
