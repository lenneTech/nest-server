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
  getDefaultAuthCookieOptions,
  isCookiesEnabled,
  isCorsDisabled,
  isExposeTokenInBodyEnabled,
  isProductionLikeEnv,
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
