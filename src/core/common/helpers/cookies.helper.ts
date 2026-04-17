import type { Response } from 'express';

import type { ICookiesConfig, ICorsConfig, IServerOptions } from '../interfaces/server-options.interface';

/**
 * Module-scoped cache of `process.env.NODE_ENV === 'production'`.
 *
 * `process.env` reads are cheap but not free; the auth hot path calls cookie helpers
 * on every sign-in/sign-up/refresh. Since `NODE_ENV` is established at process start
 * and immutable for the server lifetime, we read it once at import time.
 *
 * @since 11.25.0
 */
const IS_PRODUCTION_NODE_ENV = process.env.NODE_ENV === 'production';

/**
 * Checks whether the given environment should be treated as production-like.
 *
 * Production-like means auth cookies must be set with `secure: true`
 * (HTTPS-only). Triggers when EITHER:
 * - `env === 'production'` or `env === 'staging'` (app-level `config.env`), OR
 * - `process.env.NODE_ENV === 'production'` (runtime Node environment)
 *
 * Checking both layers protects staging deployments that set `config.env = 'staging'`
 * but do not set `NODE_ENV=production`, and vice versa.
 *
 * @since 11.25.0
 */
export function isProductionLikeEnv(env?: string): boolean {
  if (env === 'production' || env === 'staging') return true;
  return IS_PRODUCTION_NODE_ENV;
}

/**
 * Standard cookie options for authentication cookies.
 *
 * Applied to both Legacy Auth (`token`, `refreshToken`) and BetterAuth cookies.
 * Enforces baseline security (httpOnly, sameSite=lax) and environment-aware
 * secure flag (HTTPS-only in production).
 *
 * @since 11.25.0
 */
export interface AuthCookieDefaultOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
}

/**
 * Returns the default secure cookie options for authentication cookies.
 *
 * - `httpOnly: true` — prevents JavaScript access (XSS mitigation)
 * - `sameSite: 'lax'` — CSRF mitigation
 * - `secure: isProductionLikeEnv(env)` — HTTPS-only in production/staging
 *
 * Used by both Legacy Auth and BetterAuth cookie helpers for consistent security.
 *
 * @param env - App-level environment from `IServerOptions.env` (e.g. `'production'`, `'staging'`, `'ci'`).
 *              Falls back to `process.env.NODE_ENV === 'production'` if absent.
 *
 * @since 11.25.0
 */
export function getDefaultAuthCookieOptions(env?: string): AuthCookieDefaultOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProductionLikeEnv(env),
  };
}

/**
 * Asserts that the cookies configuration is safe for production/staging environments.
 *
 * Throws if `exposeTokenInBody: true` is combined with a production-like environment.
 * Rationale: Exposing the session token in the response body negates the XSS
 * protection of the httpOnly session cookie — it enables XSS attacks to read
 * the token from the response body.
 *
 * Test environments (ci, e2e, development, local) may use `exposeTokenInBody: true`
 * for TestHelper to read tokens — these are guarded against by the env check.
 *
 * @throws Error if configuration is unsafe for production/staging
 *
 * @since 11.25.0
 */
export function assertCookiesProductionSafe(
  cookies: boolean | ICookiesConfig | undefined,
  env: string | undefined,
): void {
  // Use the shared production-like detection so the guard triggers symmetrically with the
  // `secure` cookie flag: both app-level `env` ('production'/'staging') AND runtime
  // `NODE_ENV=production` are covered. A deployment that sets only `NODE_ENV=production`
  // but forgets the app `env` field must still be blocked from exposeTokenInBody.
  if (isProductionLikeEnv(env) && isExposeTokenInBodyEnabled(cookies)) {
    throw new Error(
      'SECURITY: cookies.exposeTokenInBody must not be true in production or staging. ' +
        'Exposing the session token in the response body negates the XSS protection of ' +
        'the httpOnly session cookie. If hybrid JWT+Cookie auth is required, handle the ' +
        'token at the client layer (e.g., via getToken endpoint) instead of exposing it in ' +
        'the login response body.',
    );
  }
}

/**
 * Sets legacy auth cookies (`token`, `refreshToken`) on the response with secure defaults.
 *
 * Consolidates cookie-setting logic shared between `CoreAuthController` (REST) and
 * `CoreAuthResolver` (GraphQL). Applies standard security options (httpOnly, sameSite,
 * secure-in-production) and honors `exposeTokenInBody` by optionally stripping tokens
 * from the response body after setting cookies.
 *
 * @param res - Express Response object
 * @param result - Auth result containing `token` and `refreshToken` (modified in place)
 * @param cookies - The `cookies` config value from IServerOptions
 * @param env - App-level env from `IServerOptions.env` (used for `secure` flag derivation)
 * @returns The (possibly modified) result object
 *
 * @since 11.25.0
 */
export function setLegacyAuthCookies<T extends { refreshToken?: string; token?: string } | null | undefined>(
  res: Response,
  result: T,
  cookies: boolean | ICookiesConfig | undefined,
  env?: string,
): T {
  if (!isCookiesEnabled(cookies)) {
    return result;
  }

  const cookieOptions = getDefaultAuthCookieOptions(env);

  // If result is absent or not an object, clear any existing cookies (logout path)
  if (!result || typeof result !== 'object') {
    res.cookie('token', '', cookieOptions);
    res.cookie('refreshToken', '', cookieOptions);
    return result;
  }

  res.cookie('token', result.token || '', cookieOptions);
  res.cookie('refreshToken', result.refreshToken || '', cookieOptions);

  // Remove tokens from response body unless exposeTokenInBody is enabled
  if (!isExposeTokenInBodyEnabled(cookies)) {
    if (result.token) {
      delete result.token;
    }
    if (result.refreshToken) {
      delete result.refreshToken;
    }
  }

  return result;
}

/**
 * Checks if cookies are enabled based on the cookies config value.
 *
 * Follows the Boolean Shorthand Pattern:
 * - `undefined` → true (enabled by default)
 * - `true` → true
 * - `false` → false
 * - `{}` → true (presence implies enabled)
 * - `{ enabled: true }` → true
 * - `{ enabled: false }` → false
 * - `{ exposeTokenInBody: true }` → true (enabled, token exposed)
 *
 * @since 11.25.0
 */
export function isCookiesEnabled(cookies: boolean | ICookiesConfig | undefined): boolean {
  if (cookies === false) return false;
  if (typeof cookies === 'object' && cookies !== null) return cookies.enabled !== false;
  return true; // undefined or true → enabled (default)
}

/**
 * Checks if exposeTokenInBody is enabled based on the cookies config value.
 *
 * When true, authentication endpoints keep the token in the response body
 * even when cookies are active. By default false — the httpOnly cookie
 * provides XSS protection, exposing the token in the body would negate that.
 *
 * @since 11.25.0
 */
export function isExposeTokenInBodyEnabled(cookies: boolean | ICookiesConfig | undefined): boolean {
  if (typeof cookies === 'object' && cookies !== null) return cookies.exposeTokenInBody === true;
  return false; // Default: false
}

/**
 * Determines whether a BetterAuth session token must be converted to a JWT
 * before being returned to the client.
 *
 * Conversion is required when the client actually reads the token from the
 * response body — otherwise the opaque session token travels via cookie only
 * and never needs to be a JWT.
 *
 * Truth table:
 *
 * | cookies                         | jwtEnabled | convert? |
 * |---------------------------------|------------|----------|
 * | `false` (JWT-only mode)         | true       | yes      |
 * | `true` / `{}` (cookie-only)     | true       | no       |
 * | `{ exposeTokenInBody: true }`   | true       | yes      |
 * | any                             | false      | no       |
 *
 * @param cookies - The `cookies` config value from IServerOptions
 * @param jwtEnabled - Whether the BetterAuth JWT plugin is enabled
 * @returns true if the caller should convert the session token to a JWT
 *
 * @since 11.25.0
 */
export function shouldConvertSessionTokenToJwt(
  cookies: boolean | ICookiesConfig | undefined,
  jwtEnabled: boolean,
): boolean {
  if (!jwtEnabled) return false;
  const cookiesEnabled = isCookiesEnabled(cookies);
  const exposeTokenInBody = isExposeTokenInBodyEnabled(cookies);
  // Cookies-only mode: token delivered via cookie, no body JWT needed
  if (cookiesEnabled && !exposeTokenInBody) return false;
  return true;
}

/**
 * Checks if CORS is disabled based on the cors config value.
 *
 * CORS is disabled when:
 * - `cors === false`
 * - `cors.enabled === false`
 *
 * @since 11.25.0
 */
export function isCorsDisabled(cors: boolean | ICorsConfig | undefined): boolean {
  if (cors === false) return true;
  if (typeof cors === 'object' && cors !== null) return cors.enabled === false;
  return false;
}

/**
 * Builds a CORS configuration object from server options.
 *
 * Resolution priority:
 * 1. CORS disabled → empty object (no CORS)
 * 2. Cookies disabled → empty object (no credentials needed, handled by simple enableCors())
 * 3. `cors.allowAll` → `{ credentials: true, origin: true }` (mirror request origin)
 * 4. `cors.allowedOrigins` + `appUrl`/`baseUrl` → deduplicated origin list
 * 5. Only `appUrl`/`baseUrl` → those origins
 * 6. Nothing configured → `{}` (no credentialed CORS — caller decides fallback)
 *
 * Used by both:
 * - `CoreModule.buildCorsConfig()` for GraphQL (Apollo) CORS
 * - `main.ts` reference implementation for REST (Express) CORS
 *
 * Security note: when no origins are resolvable AND cookies are enabled, the function
 * returns `{}` rather than `{ credentials: true, origin: true }`. Returning open CORS
 * with credentials would allow any website to make credentialed requests. Callers
 * should either configure `appUrl`/`baseUrl`/`allowedOrigins`, enable `cors.allowAll`
 * explicitly (for development), or accept no credentialed CORS.
 *
 * @param options - Server options containing `cors`, `cookies`, `appUrl`, `baseUrl`
 * @returns CORS config object for Apollo/Express, or empty object if disabled/unconfigured
 *
 * @since 11.25.0
 */
export function buildCorsConfig(options: Partial<IServerOptions>): Record<string, unknown> {
  if (isCorsDisabled(options?.cors)) {
    return {};
  }

  if (!isCookiesEnabled(options?.cookies)) {
    return {};
  }

  const corsObj = typeof options?.cors === 'object' ? options.cors : {};

  // allowAll → mirror request origin (explicit opt-in for dev/test)
  if (corsObj.allowAll) {
    return { credentials: true, origin: true };
  }

  // Build origin list from appUrl, baseUrl, and allowedOrigins
  const origins: string[] = [];
  if (options?.appUrl) origins.push(options.appUrl);
  if (options?.baseUrl) origins.push(options.baseUrl);
  if (corsObj.allowedOrigins?.length) {
    origins.push(...corsObj.allowedOrigins);
  }

  const uniqueOrigins = [...new Set(origins)];

  if (uniqueOrigins.length > 0) {
    return { credentials: true, origin: uniqueOrigins };
  }

  // No origins resolvable → return empty (secure default — no open CORS with credentials)
  return {};
}
