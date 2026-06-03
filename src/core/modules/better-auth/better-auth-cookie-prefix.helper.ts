/**
 * Single source of truth for the Better-Auth session cookie prefix.
 *
 * The session cookie is named `<prefix>.session_token` (e.g. `iam.session_token`).
 * The prefix is resolved here — and ONLY here — so every place that sets, reads,
 * signs, extracts or clears the session cookie agrees on the exact name. (A
 * previous bug derived the name from `basePath` independently in 6 places, so a
 * `COOKIE_PREFIX` override broke the auth pipeline: Better-Auth set
 * `acme.session_token` while the NestJS layer still looked for `iam.session_token`.)
 *
 * Dependency-free on purpose so it can be imported from the config builder, the
 * service, controllers and helpers without any import cycle.
 */

/**
 * Characters allowed in a cookie-name token. A safe subset of RFC 6265 that is
 * IDENTICAL to the frontend resolver (`@lenne.tech/nuxt-extensions`
 * `resolveLtCookiePrefix`), so a shared `COOKIE_PREFIX` produces the SAME prefix
 * on both sides. Everything else (spaces, `;`, `=`, `\r`, `\n`, …) is stripped so
 * a typo can never corrupt the `Set-Cookie` header.
 */
function sanitizeCookiePrefix(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9._-]/g, '');
}

/**
 * Resolve the Better-Auth cookie prefix (the `iam` in `iam.session_token`).
 *
 * Precedence:
 *   1. **`COOKIE_PREFIX` env** (dedicated, always wins) — for fully autonomous
 *      cookie isolation on a shared host (several lenne.tech apps on the same
 *      host, where cookies collide by host, not port). Sanitised to valid
 *      cookie-name characters; if it sanitises to empty it is ignored.
 *   2. otherwise the **basePath-derived** prefix (`/iam` → `iam`,
 *      `/api/iam` → `api.iam`) — the previous behaviour, fully backward
 *      compatible when `COOKIE_PREFIX` is unset.
 *
 * IMPORTANT: when `COOKIE_PREFIX` is set it MUST match the frontend
 * `NUXT_PUBLIC_COOKIE_PREFIX` (see `@lenne.tech/nuxt-extensions`
 * `resolveLtCookiePrefix`) — otherwise the two sides use different cookie names
 * and authentication breaks.
 *
 * @param basePath - Better-Auth base path (e.g. `/iam`)
 * @param env - environment to read `COOKIE_PREFIX` from (defaults to `process.env`)
 */
export function resolveBetterAuthCookiePrefix(basePath: string, env: NodeJS.ProcessEnv = process.env): string {
  const basePathPrefix = (basePath || '/iam').replace(/^\//, '').replace(/\//g, '.');
  const explicit = sanitizeCookiePrefix(typeof env.COOKIE_PREFIX === 'string' ? env.COOKIE_PREFIX : '');
  return explicit || basePathPrefix;
}

/**
 * Convenience: the full session-cookie name (`<prefix>.session_token`) for the
 * given basePath, honouring `COOKIE_PREFIX`. Use this wherever the session
 * cookie name is needed so all call sites stay in lockstep.
 */
export function resolveBetterAuthSessionCookieName(basePath: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveBetterAuthCookiePrefix(basePath, env)}.session_token`;
}

/**
 * Detect a Better-Auth cookie-prefix drift between the value the NestJS layer
 * resolves (via {@link resolveBetterAuthCookiePrefix}) and a programmatic
 * `options.advanced.cookiePrefix` passed straight to Better-Auth. Such a
 * mismatch silently breaks the auth pipeline because Better-Auth sets the
 * cookie under the programmatic prefix while the NestJS read/clear path still
 * uses the resolved prefix.
 *
 * Returns `null` when there is no drift (no programmatic prefix, or it
 * matches), otherwise a human-readable warning sentence ready for `logger.warn`.
 *
 * Extracted so the drift-detection logic is testable without booting the full
 * Better-Auth instance (which requires Mongo).
 */
export function detectCookiePrefixDrift(resolvedPrefix: string, programmaticOptionsAdvanced: unknown): null | string {
  if (!programmaticOptionsAdvanced || typeof programmaticOptionsAdvanced !== 'object') return null;
  const programmaticPrefix = (programmaticOptionsAdvanced as Record<string, unknown>).cookiePrefix;
  if (typeof programmaticPrefix !== 'string' || programmaticPrefix === resolvedPrefix) return null;
  return (
    `options.advanced.cookiePrefix="${programmaticPrefix}" overrides Better-Auth but the ` +
    `NestJS layer still uses "${resolvedPrefix}". This will break sign-in / read / sign-out — ` +
    `use the COOKIE_PREFIX env variable instead (honoured by every call site).`
  );
}
