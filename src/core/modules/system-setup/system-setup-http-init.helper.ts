import { createHash, timingSafeEqual } from 'node:crypto';

import { isLocalEnv } from '../../common/helpers/cookies.helper';

/**
 * The request header `POST /system-setup/init` reads the setup token from (`systemSetup.httpInit.token`).
 *
 * A header, never a body field: the body is the admin's credentials and is shaped by the DTO, while the token is a
 * deployment secret the operator hands out separately. Header names are case-insensitive; Express lowercases them.
 *
 * @since 11.46.0
 */
export const SYSTEM_SETUP_TOKEN_HEADER = 'x-system-setup-token';

/**
 * Minimum length of a configured setup token.
 *
 * The init route is anonymous and not rate-limited, so the token is all that stands between a caller and an
 * administrator account. A shorter value is refused as a misconfiguration (the HTTP init stays closed), never
 * accepted as a weak gate.
 *
 * @since 11.46.0
 */
export const SYSTEM_SETUP_TOKEN_MIN_LENGTH = 16;

/**
 * Whether `POST /system-setup/init` may run, as decided from `systemSetup.httpInit` and the environment.
 *
 * @since 11.46.0
 */
export interface ISystemSetupHttpInitPolicy {
  /** The HTTP init is open (with or without a token) */
  enabled: boolean;

  /**
   * What is wrong with the configuration when it is unusable — a token that is missing, empty, too short or not a
   * string. Set only when the configuration asked for a token-protected init and could not get one; the init then
   * stays CLOSED. Meant for the boot log.
   */
  problem?: string;

  /** Why the decision came out this way: the environment default, or an explicit setting */
  source: 'config' | 'default';

  /** The configured token, when the init is open and token-protected */
  token?: string;

  /** A token must be sent in {@link SYSTEM_SETUP_TOKEN_HEADER} */
  tokenRequired: boolean;
}

/**
 * Decide whether the anonymous `POST /system-setup/init` is open, from `systemSetup.httpInit` and the environment.
 *
 * Fail-closed in every branch that is not an explicit, well-formed opt-in:
 *
 * | `httpInit`                            | `local` / `ci` / `e2e` | every other environment |
 * |---------------------------------------|------------------------|-------------------------|
 * | not set (or not a boolean / object)   | open, no token         | **closed**              |
 * | `true`                                | open, no token         | open, no token          |
 * | `false` / `{ enabled: false, … }`     | closed                 | closed                  |
 * | `{ token: '<≥ 16 characters>' }`      | open, token required   | open, token required    |
 * | an object without a usable token      | closed + `problem`     | closed + `problem`      |
 *
 * The environment test is {@link isLocalEnv}: the deployed `develop` and `test` stages of a starter-based project,
 * `production`, `staging` and an unknown or missing name all count as deployed.
 *
 * Why an object without a usable token CLOSES rather than opening without one: the natural way to write the option is
 * `httpInit: { token: process.env.SETUP_TOKEN }`, and with the variable missing that is `{ token: undefined }`. Reading
 * it as "open, no token" would turn a forgotten secret into an anonymous administrator endpoint — the incident this
 * exists for. A value from `NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN` that is empty or all digits arrives as a NUMBER
 * (`getEnvironmentObject()` converts numeric strings, `''` included, and a long digit string loses digits on the way),
 * so a non-string token is refused too. And a non-boolean `httpInit` (the string `'true'` from `NEST_SERVER_CONFIG`)
 * reads as "not set", so a string cannot open the route by truthiness.
 *
 * @since 11.46.0
 */
export function resolveSystemSetupHttpInit(httpInit: unknown, env: string | undefined): ISystemSetupHttpInitPolicy {
  if (httpInit === true) {
    return { enabled: true, source: 'config', tokenRequired: false };
  }
  if (httpInit === false) {
    return { enabled: false, source: 'config', tokenRequired: false };
  }
  if (httpInit && typeof httpInit === 'object' && !Array.isArray(httpInit)) {
    const { enabled, token } = httpInit as { enabled?: unknown; token?: unknown };
    if (enabled === false) {
      return { enabled: false, source: 'config', tokenRequired: false };
    }
    const problem = tokenProblem(token);
    if (problem) {
      return { enabled: false, problem, source: 'config', tokenRequired: false };
    }
    return { enabled: true, source: 'config', token: token as string, tokenRequired: true };
  }
  return { enabled: isLocalEnv(env), source: 'default', tokenRequired: false };
}

/**
 * Whether `provided` (the header value) matches the configured `expected` token.
 *
 * Both sides are hashed to the same length before `timingSafeEqual`, so neither the content nor the LENGTH of the
 * configured token leaks through the response time. A missing, empty or non-string value never matches.
 *
 * @since 11.46.0
 */
export function isSystemSetupTokenValid(expected: string | undefined, provided: unknown): boolean {
  if (typeof expected !== 'string' || !expected || typeof provided !== 'string' || !provided) {
    return false;
  }
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(provided));
}

/** Why a configured token cannot be used, or `undefined` when it can */
function tokenProblem(token: unknown): string | undefined {
  if (token === undefined || token === null) {
    return 'systemSetup.httpInit is an object without a token';
  }
  if (typeof token !== 'string') {
    return (
      `systemSetup.httpInit.token is a ${typeof token}, not a string — an empty or all-digit ` +
      'NSC__SYSTEM_SETUP__HTTP_INIT__TOKEN is converted to a number; use a token with letters'
    );
  }
  if (token.trim().length < SYSTEM_SETUP_TOKEN_MIN_LENGTH) {
    return `systemSetup.httpInit.token is shorter than ${SYSTEM_SETUP_TOKEN_MIN_LENGTH} characters`;
  }
  return undefined;
}
