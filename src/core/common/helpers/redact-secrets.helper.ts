/**
 * Recursive, non-mutating secret redaction for configuration objects and anything shaped like them.
 *
 * The framework's ONE masker: `GET /config` (`configEndpointResponse()`), the Hub config panel and the
 * `ConfigService` debug output all go through it, so they cannot drift apart. It moved here from the Hub
 * (`hub-mask.helper.ts`, which re-exports it as `maskConfigDeep`) in 12.5.0.
 *
 * CRITICAL: this deep-clones before masking. A response must never be handed a live, service-owned object —
 * `CheckSecurityInterceptor` deletes secret-named keys IN PLACE, which would corrupt the running server config.
 * Cloning here is the guarantee.
 *
 * It errs towards masking: a value that only looks secret costs an operator a look into the environment, a
 * missed secret costs the platform.
 *
 * @since 12.5.0 (as `maskConfigDeep` in the Hub since 11.x)
 */

/**
 * Key-name heuristics that mark a value as secret. Matched case-insensitively against each key.
 *
 * `access[-_]?key` also covers `accessKeyId`: the trailing `(^|[^a-z])key([^a-z]|$)` alternative
 * does NOT, because the `i` flag makes `[^a-z]` reject an uppercase letter, so `…sKeyI…` fails it.
 * `s3.secretAccessKey` was already caught by `secret`; the ID was not.
 *
 * `dsn` (a Sentry-style DSN carries its key as the URI user) and `salt` came from the template the
 * nest-server-starter used before 12.5.0.
 */
const SECRET_KEY_PATTERN =
  /secret|passwd|password|passphrase|credential|api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|encryption|\btoken\b|\bpass\b|dsn|salt|(^|[^a-z])key([^a-z]|$)/i;

/**
 * Value-shape heuristic: a connection URI carrying `scheme://user:password@host`.
 *
 * The user part is `*`, not `+`, so the PASSWORD-ONLY form is matched too:
 * `redis://:password@host` is the canonical Redis URL (Redis < 6 has no username, and
 * `redis-cli -u`, Heroku Redis and ElastiCache AUTH all emit it).
 *
 * Still safe against false positives: the password group cannot contain `/`, and the `@`
 * must follow it immediately — so `http://host:8080/x@y` does not match.
 */
const URI_CREDENTIAL_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/[^/@:\s]*:)([^@/\s]+)(@)/i;

/**
 * A query parameter of a URI-shaped value (`?password=…`, `&sslpassword=…`, `&token=…`). Its value is masked when
 * the parameter name is secret by {@link SECRET_KEY_PATTERN}: a PostgreSQL or MongoDB URL can carry a password there
 * instead of in the user info.
 */
const URI_QUERY_PARAM_PATTERN = /([?&])([^=&#\s]+)=([^&#\s]*)/g;

/** What a masked value reads as */
export const REDACTED_VALUE = '***';

/**
 * Field names the framework treats as secret wherever they appear, whatever the key pattern says (the defaults of
 * `security.secretFields`, see `CheckSecurityInterceptor`).
 *
 * @since 12.5.0
 */
export const FRAMEWORK_SECRET_FIELDS: readonly string[] = [
  'password',
  'verificationToken',
  'passwordResetToken',
  'passwordResetTokenExpiresAt',
  'refreshTokens',
  'tempTokens',
  'apiKeyEncrypted',
];

/**
 * Deep-clone `value` and mask every secret it contains.
 *
 * - A value whose key matches {@link SECRET_KEY_PATTERN} or appears in `extraSecretKeys` is masked. Below such a key
 *   EVERYTHING is masked — a nested object is never a way around it — except booleans, which carry no secret and
 *   keep flags such as `emailAndPassword.disableSignUp` readable.
 * - A string shaped like a connection URI has the password of its user info masked, and every secret-named query
 *   parameter, whatever its key is called.
 * - `null` and `undefined` pass through; a `Date` or `Buffer` is kept as it is (masked under a secret key).
 *
 * @param value - the object or value to mask (never mutated)
 * @param extraSecretKeys - additional exact key names to always mask (e.g. `security.secretFields`)
 * @since 12.5.0
 */
export function redactSecrets<T>(value: T, extraSecretKeys: readonly string[] = []): T {
  const extra = new Set(extraSecretKeys.filter((key) => typeof key === 'string').map((key) => key.toLowerCase()));
  return redactValue(value, false, extra) as T;
}

function isSecretKey(key: string, extra: Set<string>): boolean {
  return extra.has(key.toLowerCase()) || SECRET_KEY_PATTERN.test(key);
}

function redactString(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value;
  }
  const withoutUserPassword = value.replace(URI_CREDENTIAL_PATTERN, `$1${REDACTED_VALUE}$3`);
  return withoutUserPassword.replace(URI_QUERY_PARAM_PATTERN, (match, separator: string, name: string) =>
    SECRET_KEY_PATTERN.test(safeDecode(name)) ? `${separator}${name}=${REDACTED_VALUE}` : match,
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactValue(value: unknown, underSecretKey: boolean, extra: Set<string>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Primitives
  if (typeof value !== 'object') {
    if (underSecretKey) {
      return typeof value === 'boolean' ? value : REDACTED_VALUE;
    }
    return typeof value === 'string' ? redactString(value) : value;
  }

  // Non-plain objects (Date, Buffer) are kept as they are — cloning would lose their type, and they carry no framework
  // secret — unless they sit below a secret key
  if (value instanceof Date || Buffer.isBuffer(value)) {
    return underSecretKey ? REDACTED_VALUE : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, underSecretKey, extra));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactValue(item, underSecretKey || isSecretKey(key, extra), extra);
  }
  return out;
}
