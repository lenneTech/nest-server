/**
 * Recursive, non-mutating config masker for the Hub config viewer.
 *
 * CRITICAL: this deep-clones before masking. Hub JSON sidecars must never hand a live,
 * service-owned object to the response pipeline — `CheckSecurityInterceptor` deletes secret-named
 * keys IN PLACE, which would corrupt the running server config. Cloning here is the guarantee.
 */

/**
 * Key-name heuristics that mark a value as secret. Matched case-insensitively against each key.
 *
 * `access[-_]?key` also covers `accessKeyId`: the trailing `(^|[^a-z])key([^a-z]|$)` alternative
 * does NOT, because the `i` flag makes `[^a-z]` reject an uppercase letter, so `…sKeyI…` fails it.
 * `s3.secretAccessKey` was already caught by `secret`; the ID was not.
 */
const SECRET_KEY_PATTERN =
  /secret|passwd|password|passphrase|credential|api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|encryption|\btoken\b|\bpass\b|(^|[^a-z])key([^a-z]|$)/i;

/**
 * Value-shape heuristic: a connection URI carrying `scheme://user:password@host`.
 *
 * The user part is `*`, not `+`, so the PASSWORD-ONLY form is matched too:
 * `redis://:password@host` is the canonical Redis URL (Redis < 6 has no username, and
 * `redis-cli -u`, Heroku Redis and ElastiCache AUTH all emit it). Requiring a non-empty
 * user printed that shape verbatim in the Hub config panel. `redis.url` became a
 * first-class option in 11.33.0, so the shape is newly reachable here.
 *
 * Still safe against false positives: the password group cannot contain `/`, and the `@`
 * must follow it immediately — so `http://host:8080/x@y` does not match.
 */
const URI_CREDENTIAL_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/[^/@:\s]*:)([^@/\s]+)(@)/i;

const MASK = '***';

/**
 * Deep-clone `value` and mask every secret it contains.
 *
 * A value is masked when its key matches {@link SECRET_KEY_PATTERN} or appears in `extraSecretKeys`.
 * Additionally, any string that looks like a credentialed connection URI has its password segment
 * masked regardless of key name.
 *
 * @param value - the object/value to mask (not mutated)
 * @param extraSecretKeys - additional exact key names to always mask (e.g. `security.secretFields`)
 */
export function maskConfigDeep<T>(value: T, extraSecretKeys: string[] = []): T {
  const extra = new Set(extraSecretKeys.map((k) => k.toLowerCase()));
  return maskValue(value, false, extra) as T;
}

function isSecretKey(key: string, extra: Set<string>): boolean {
  return extra.has(key.toLowerCase()) || SECRET_KEY_PATTERN.test(key);
}

function maskString(value: string): string {
  const uriMatch = value.match(URI_CREDENTIAL_PATTERN);
  if (uriMatch) {
    return value.replace(URI_CREDENTIAL_PATTERN, `$1${MASK}$3`);
  }
  return value;
}

function maskValue(value: unknown, keyIsSecret: boolean, extra: Set<string>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Primitives.
  if (typeof value !== 'object') {
    if (keyIsSecret) {
      return MASK;
    }
    return typeof value === 'string' ? maskString(value) : value;
  }

  // A whole secret-keyed object/array is collapsed to the mask (never leak its interior).
  if (keyIsSecret) {
    return MASK;
  }

  // Preserve non-plain objects verbatim (Date, Buffer, etc.) — cloning would lose their type and
  // they never carry framework secrets.
  if (value instanceof Date || Buffer.isBuffer(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, false, extra));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = maskValue(val, isSecretKey(key, extra), extra);
  }
  return out;
}
