/**
 * Which sessions a Better-Auth JWT may still act for (12.11.0) — an import-free leaf, so the session-deletion hook in
 * `better-auth.config.ts`, `CoreBetterAuthService` and the user mapper's Redis broadcast reach the same entries
 * without importing each other.
 *
 * A JWT carries the id of the session it was issued from (`sid`). `CoreBetterAuthService.verifyJwtToken()` accepts it
 * only while that session exists, belongs to the token's subject and has not expired; the answer is kept here for a
 * few seconds, and a deleted session is forgotten at once (`jwtSessionEnded()`), on every replica where Redis
 * carries the broadcast. Before 12.11.0 a JWT stayed valid until its own expiry (15 minutes by default) after a
 * sign-out, a revoked session or a deleted user.
 *
 * Process-local and bounded: at most {@link JWT_SESSION_CACHE_MAX} entries, the oldest evicted first.
 */

/** Most sessions the cache holds; beyond it the oldest entry is evicted. */
export const JWT_SESSION_CACHE_MAX = 10_000;

interface JwtSessionEntry {
  live: boolean;
  /** The session with its user, when a lookup fetched them (`CoreBetterAuthService.getJwtSession()`). */
  record?: unknown;
  /** Epoch milliseconds until which the answer stands. */
  until: number;
  userId: string;
}

const entries = new Map<string, JwtSessionEntry>();

let broadcaster: ((sessionId: string) => void) | undefined;

/**
 * The cached answer for the session `sessionId` of `userId`: `true` / `false` while it stands, `undefined` when it has
 * to be asked again. An entry for another user never answers `true`.
 */
export function cachedJwtSession(sessionId: string, userId: string, now = Date.now()): boolean | undefined {
  const entry = entries.get(sessionId);
  if (!entry) {
    return undefined;
  }
  if (entry.until <= now) {
    entries.delete(sessionId);
    return undefined;
  }
  return entry.live && entry.userId === userId;
}

/**
 * The cached session with its user for the session `sessionId` of `userId` — only while the answer stands, the
 * session lives and belongs to that user.
 */
export function cachedJwtSessionRecord(sessionId: string, userId: string, now = Date.now()): unknown {
  return cachedJwtSession(sessionId, userId, now) ? entries.get(sessionId)?.record : undefined;
}

/**
 * Keeps the answer for the session `sessionId` of `userId` until `until` (epoch milliseconds), with the session and
 * its user when the lookup fetched them. An answer without a record keeps a record already held for a live session.
 */
export function rememberJwtSession(
  sessionId: string,
  userId: string,
  live: boolean,
  until: number,
  record?: unknown,
): void {
  const previous = entries.get(sessionId);
  const kept = record ?? (live && previous?.live && previous.userId === userId ? previous.record : undefined);
  entries.delete(sessionId);
  if (entries.size >= JWT_SESSION_CACHE_MAX) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) {
      entries.delete(oldest);
    }
  }
  entries.set(sessionId, { live, record: kept, until, userId });
}

/** Forgets the answer for the session `sessionId` on this process only — for a broadcast received from a replica. */
export function forgetJwtSession(sessionId: string): void {
  entries.delete(sessionId);
}

/**
 * The session `sessionId` has ended (signed out, revoked, its user deleted): forget it here and tell the other
 * replicas. Never throws — it runs inside Better-Auth's deletion.
 */
export function jwtSessionEnded(sessionId: string): void {
  entries.delete(sessionId);
  try {
    broadcaster?.(sessionId);
  } catch {
    // The other replicas forget it when their entry expires.
  }
}

/** Registers how an ended session reaches the other replicas (the user mapper's Redis channel); `undefined` removes it. */
export function setJwtSessionBroadcaster(fn: ((sessionId: string) => void) | undefined): void {
  broadcaster = fn;
}

/** Empties the cache — for tests and a module that is torn down. */
export function clearJwtSessionCache(): void {
  entries.clear();
}
