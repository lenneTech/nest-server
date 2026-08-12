import { Logger } from '@nestjs/common';

import type { CoreRedisService } from './core-redis.service';

/**
 * Escape Redis glob metacharacters so a LITERAL key can be embedded in a `SCAN MATCH` pattern.
 *
 * Keys embed values the caller controls (an IP, an endpoint, an email), and `resetByPrefix` turns
 * such a value into a pattern — where an unescaped `*` or `?` would silently widen the match to
 * other callers' counters.
 *
 * Applied to the PATTERN only, never to the key being written. Escaping both is how the two stop
 * meeting: the stored key then carries the backslashes literally while the pattern's `\x` matches
 * a single unescaped `x`, so a reset matched nothing at all for any key containing `\` — which
 * {@link rateLimitKey} produces for every IPv6 address — or a glob metacharacter.
 */
function escapeGlob(value: string): string {
  return value.replace(/[?[\]*\\^]/g, (char) => `\\${char}`);
}

/**
 * Join caller-controlled parts into ONE rate-limit key.
 *
 * `:` separates the segments of every key the framework builds, so a part that CONTAINS a colon
 * straddles the boundary and two different callers collapse onto one counter: ip `1.2.3.4:5` with
 * endpoint `/a` produces the same key as ip `1.2.3.4` with endpoint `5:/a`. Both parts are
 * caller-influenced (a forwarded-for value, a request path), so that is a bucket a client can aim
 * at — sharing, and therefore exhausting, someone else's limit.
 *
 * Escaping happens at CONSTRUCTION, not in the Redis key builder, so the in-memory store gets the
 * same separation as the Redis one instead of only the SCAN path being protected. `\` is escaped
 * first, otherwise a literal `\` in a part could forge the escape of a following colon.
 */
export function rateLimitKey(...parts: string[]): string {
  return parts.map((part) => part.replace(/\\/g, '\\\\').replace(/:/g, '\\:')).join(':');
}

/**
 * Prefix covering every {@link rateLimitKey} that starts with `parts` — for
 * {@link RateLimitStore.resetByPrefix}. The trailing separator is the real one, so a reset for
 * ip `1.2.3.4` cannot also match ip `1.2.3.40`.
 */
export function rateLimitKeyPrefix(...parts: string[]): string {
  return `${rateLimitKey(...parts)}:`;
}

/**
 * Human-readable limiter name for a log line
 */
function namespaceLabel(namespace: string): string {
  return `namespace ${namespace}`;
}

/**
 * Result of a rate limit hit
 */
export interface RateLimitStoreHit {
  /** Current request count in the window (including this hit) */
  count: number;
  /** Seconds until the window resets */
  resetIn: number;
}

/**
 * Fixed-window rate limit counter storage.
 *
 * Implementations: InMemoryRateLimitStore (process-local, default) and
 * RedisRateLimitStore (distributed — the effective limit stays exact across
 * replicas instead of multiplying by the replica count).
 */
export interface RateLimitStore {
  /** Remove all entries (testing/admin) */
  clear(): Promise<void>;

  /** Count one hit for the key within a fixed window */
  hit(key: string, windowSeconds: number): Promise<RateLimitStoreHit>;

  /** Remove all entries whose key starts with the prefix (admin reset per IP) */
  resetByPrefix(prefix: string): Promise<void>;

  /** Number of active entries, or -1 when not cheaply known (Redis) */
  size(): number;

  /**
   * Release timers and connections the store owns (graceful shutdown).
   *
   * On the interface, not just on the in-memory class: a RedisRateLimitStore owns an in-memory
   * FALLBACK store, so an owner that released only `instanceof InMemoryRateLimitStore` left that
   * fallback's cleanup interval running for the life of the process.
   */
  destroy?(): void;
}

/** How many shared counters a saturated {@link InMemoryRateLimitStore} folds unknown keys into */
const OVERFLOW_BUCKETS = 64;

/** Cheap, stable string hash — picks the overflow bucket for a key. Not security-sensitive. */
function overflowSlot(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % OVERFLOW_BUCKETS;
}

/**
 * Process-local fixed-window store (previous behavior of all framework rate
 * limiters). Entries are capped and cleaned up periodically.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  protected readonly store = new Map<string, { count: number; resetTime: number }>();
  protected cleanupInterval: NodeJS.Timeout | null = null;

  /** Set by evictOldest() when nothing could be freed without deleting a live counter */
  protected atCapacity = false;

  /** So the capacity warning is logged once, not per request */
  protected capacityWarned = false;

  /**
   * Fixed set of shared counters that keys falling outside {@link maxEntries} are folded into.
   *
   * A full store must not become an open door. Returning an uncounted `1` for every unknown key —
   * which is what "refuse new entries at capacity" naively means — hands an attacker the bypass
   * for free: fill the store with distinct keys, and from then on every fresh key is a first
   * request and no limit ever applies. Since both key parts are caller-influenced (a spoofable
   * `X-Forwarded-For` and the request path), filling it is cheap.
   *
   * So overflow keys are still counted, just coarsely: each maps to one of a FIXED number of
   * buckets, so the overflow map cannot grow either. The cost is that unrelated clients share a
   * limit while the store is saturated — they are throttled earlier than they deserve. That is
   * the right direction to fail: a degraded limit for new clients, never no limit at all.
   */
  protected readonly overflow = new Map<number, { count: number; resetTime: number }>();

  constructor(protected readonly maxEntries = 10000) {
    // Clean up expired entries every 5 minutes; never keep the process alive
    this.cleanupInterval = setInterval(() => this.removeExpired(), 5 * 60 * 1000);
    this.cleanupInterval.unref?.();
  }

  async clear(): Promise<void> {
    this.store.clear();
    // The overflow buckets are bounded, so leaving them behind cannot leak — but they still hold
    // live counts. A test (or an admin) that clears the store and then sees a limit trip early is
    // looking at counters it believes it deleted.
    this.overflow.clear();
    this.atCapacity = false;
    this.capacityWarned = false;
  }

  async hit(key: string, windowSeconds: number): Promise<RateLimitStoreHit> {
    const now = Date.now();
    let entry = this.store.get(key);
    if (!entry || now >= entry.resetTime) {
      if (!entry && this.store.size >= this.maxEntries) {
        this.atCapacity = false;
        this.evictOldest();
        if (this.atCapacity) {
          if (!this.capacityWarned) {
            this.capacityWarned = true;
            console.warn(
              `Rate limit store is at capacity (${this.maxEntries} live counters). New clients now share ` +
                `${OVERFLOW_BUCKETS} coarse counters until entries expire, so they may be limited earlier than ` +
                'their own traffic warrants. Existing limits are unaffected.',
            );
          }
          return this.hitOverflow(key, windowSeconds, now);
        }
      }
      entry = { count: 1, resetTime: now + windowSeconds * 1000 };
      this.store.set(key, entry);
      return { count: 1, resetIn: windowSeconds };
    }
    entry.count++;
    return { count: entry.count, resetIn: Math.ceil((entry.resetTime - now) / 1000) };
  }

  async resetByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Count a key that did not fit in the store against its shared overflow bucket.
   *
   * The bucket count is what the caller sees, so a saturated store still enforces a limit.
   */
  protected hitOverflow(key: string, windowSeconds: number, now: number): RateLimitStoreHit {
    const slot = overflowSlot(key);
    const entry = this.overflow.get(slot);

    if (!entry || now >= entry.resetTime) {
      this.overflow.set(slot, { count: 1, resetTime: now + windowSeconds * 1000 });
      return { count: 1, resetIn: windowSeconds };
    }

    entry.count++;
    return { count: entry.count, resetIn: Math.ceil((entry.resetTime - now) / 1000) };
  }

  size(): number {
    return this.store.size;
  }

  /** Stop the cleanup interval (graceful shutdown / tests) */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  protected removeExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now >= entry.resetTime) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Evict when at capacity: first everything expired, then the entries closest
   * to expiry until the store is at 90% capacity.
   */
  protected evictOldest(): void {
    const removed = this.removeExpired();
    if (removed > 0 || this.store.size < this.maxEntries) {
      return;
    }
    // Every entry is still LIVE. Dropping the ones closest to expiry would delete active
    // counters — and for a rate limiter that means resetting the window of whoever is being
    // limited, which is exactly the caller flooding the store in the first place. Refusing the
    // new entry instead lets an attacker deny NEW clients a counter, but it cannot clear an
    // existing one; and the cap only binds until the next natural expiry a window later.
    this.atCapacity = true;
  }
}

/**
 * Atomic hit: cardinality check, then INCR + EXPIRE, in one round trip.
 *
 * ```
 * KEYS[1] counter key for this caller
 * KEYS[2] per-namespace cardinality counter
 * KEYS[3] shared overflow counter this key folds into once the cap is reached
 * ARGV[1] window in seconds
 * ARGV[2] maximum distinct counter keys per window
 * ```
 *
 * Returns `[count, ttlSeconds, overflow]`, where `overflow` is `1` when the coarse bucket was
 * used. The cap decision lives INSIDE the script on purpose: a read-then-decide in JavaScript is
 * a check-then-act across a network hop, and concurrent requests — precisely the traffic the cap
 * exists for — would each read the pre-increment value and all conclude there is room.
 */
const HIT_SCRIPT = `
local window = tonumber(ARGV[1])
local target = KEYS[1]
local overflow = 0
if redis.call('EXISTS', KEYS[1]) == 0 then
  local seen = redis.call('INCR', KEYS[2])
  if seen == 1 then
    redis.call('EXPIRE', KEYS[2], window)
  end
  if seen > tonumber(ARGV[2]) then
    target = KEYS[3]
    overflow = 1
  end
end
local c = redis.call('INCR', target)
if c == 1 then
  redis.call('EXPIRE', target, window)
end
local ttl = redis.call('TTL', target)
if ttl < 0 then
  redis.call('EXPIRE', target, window)
  ttl = window
end
return {c, ttl, overflow}
`;

/** Name the hit script is registered under via ioredis `defineCommand` */
const HIT_COMMAND = 'ltRateLimitHit';

/**
 * Redis-backed fixed-window store. All replicas share the counters, so the
 * configured limit is enforced exactly regardless of replica count.
 *
 * Keys: `<keyPrefix>:rate-limit:<namespace>:<key>` with the window TTL, plus two framework-owned
 * keys under the same prefix that bound the keyspace — `#meta:cardinality` and
 * `#overflow:<slot>`, see {@link RedisRateLimitStore.hit}. Everything expires with the window,
 * so there is no cleanup pass.
 */
export class RedisRateLimitStore implements RateLimitStore {
  /**
   * Process-local store used while Redis is unreachable.
   *
   * Neither of the obvious failure modes is acceptable for a rate limiter: letting the
   * error escape turns every sign-in, sign-up and password-reset into a 500 for the
   * duration of a Redis blip, and swallowing it into "allowed" silently removes the
   * brute-force protection these endpoints exist to have. Degrading to the in-memory
   * counter keeps a real bound — the exact one that applied before Redis was introduced —
   * at the known cost that the effective limit is then per replica again.
   */
  protected readonly fallback = new InMemoryRateLimitStore();

  /** Whether the current state is degraded, so the transitions are logged once each */
  protected degraded = false;

  protected readonly logger = new Logger(RedisRateLimitStore.name);

  /** So the saturation warning is logged once, not per request */
  protected capacityWarned = false;

  /**
   * Clients the hit script has already been registered on.
   *
   * `defineCommand` is per connection, and `CoreRedisService` may hand out a different client
   * after a reconnect or in a second app instance, so the set is keyed by the client object.
   * Weak, because a discarded connection must not be kept alive by this bookkeeping.
   */
  protected readonly prepared = new WeakSet<object>();

  /**
   * @param maxKeys distinct counter keys the namespace may create per window before new keys are
   *   folded into the coarse overflow buckets (see {@link RedisRateLimitStore.hit})
   */
  constructor(
    protected readonly redisService: CoreRedisService,
    protected readonly namespace: string,
    protected readonly maxKeys = 10000,
  ) {}

  async clear(): Promise<void> {
    await this.fallback.clear();
    this.capacityWarned = false;
    // The empty prefix covers the whole namespace. Built through the same pattern builder as
    // resetByPrefix on purpose: a second, hand-rolled pattern here is how the write path and the
    // scan path drifted apart in the first place.
    await this.guard(() => this.deleteByPattern(this.redisKeyPattern('')), undefined);
  }

  /**
   * Count one hit, bounding the keyspace the namespace may occupy.
   *
   * Redis keys expire, but nothing stops a caller from CREATING them: both parts of a key are
   * caller-influenced (a forwarded-for value, a request path), so an unbounded INCR is an
   * unbounded write primitive against the instance that now also holds cron leases, MCP session
   * ownership, tenant-cache invalidation and the Hub buffers. {@link InMemoryRateLimitStore} has
   * always defended against exactly this; a store that drops the defense the moment `redis` is
   * configured would turn an opt-in improvement into a silent regression.
   *
   * So the same shape applies: past `maxKeys` distinct keys per window, further NEW keys are
   * folded into a fixed set of {@link OVERFLOW_BUCKETS} shared counters. They are still counted,
   * just coarsely — unrelated clients then share a limit and are throttled earlier than their own
   * traffic warrants. That is the right direction to fail; an uncounted `1` per fresh key would be
   * a complete bypass for the price of filling the keyspace.
   */
  async hit(key: string, windowSeconds: number): Promise<RateLimitStoreHit> {
    return this.guard(
      async () => {
        const [count, ttl, overflow] = await this.runHit(key, windowSeconds);
        if (this.degraded) {
          this.degraded = false;
          this.logger.log('Redis rate limiting recovered — limits are shared across replicas again');
        }
        if (overflow && !this.capacityWarned) {
          this.capacityWarned = true;
          this.logger.warn(
            `Rate limit keyspace for ${namespaceLabel(this.namespace)} reached ${this.maxKeys} distinct counters ` +
              `within one window. New clients now share ${OVERFLOW_BUCKETS} coarse counters until the window rolls ` +
              'over, so they may be limited earlier than their own traffic warrants. Existing limits are unaffected.',
          );
        }
        return { count, resetIn: ttl };
      },
      () => this.fallback.hit(key, windowSeconds),
    );
  }

  /**
   * Execute {@link HIT_SCRIPT}, preferring the registered command over shipping the script body.
   *
   * `defineCommand` sends EVALSHA and retries with the full body only on a `NOSCRIPT` (an empty
   * script cache after a Redis restart), instead of pushing ~600 bytes of Lua on every single
   * request. The EVAL branch remains for a client that does not implement `defineCommand` —
   * a wrapper or a test double — where failing would be worse than one extra payload.
   */
  protected async runHit(key: string, windowSeconds: number): Promise<[number, number, number]> {
    const client = this.redisService.getClient() as any;
    const args = [this.redisKey(key), this.cardinalityKey(), this.overflowKey(key), windowSeconds, this.maxKeys];

    if (typeof client.defineCommand === 'function') {
      if (!this.prepared.has(client)) {
        client.defineCommand(HIT_COMMAND, { lua: HIT_SCRIPT, numberOfKeys: 3 });
        this.prepared.add(client);
      }
      return (await client[HIT_COMMAND](...args)) as [number, number, number];
    }
    return (await client.eval(HIT_SCRIPT, 3, ...args)) as [number, number, number];
  }

  async resetByPrefix(prefix: string): Promise<void> {
    await this.fallback.resetByPrefix(prefix);
    await this.guard(() => this.deleteByPattern(this.redisKeyPattern(prefix)), undefined);
  }

  size(): number {
    return -1;
  }

  /** Release the fallback store's cleanup interval */
  destroy(): void {
    this.fallback.destroy();
  }

  /**
   * Run a Redis operation, degrading to the local fallback instead of throwing
   */
  protected async guard<T>(operation: () => Promise<T>, onFailure: (() => Promise<T> | T) | undefined): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!this.degraded) {
        this.degraded = true;
        this.logger.error(
          `Redis rate limiting unavailable (${namespaceLabel(this.namespace)}): ${
            error instanceof Error ? error.message : 'Unknown error'
          }. Falling back to per-replica in-memory limits until Redis recovers.`,
        );
      }
      return onFailure ? await onFailure() : (undefined as T);
    }
  }

  /** The literal key a counter is stored under — never glob-escaped, that belongs to the pattern */
  protected redisKey(key: string): string {
    return this.redisService.key('rate-limit', this.namespace, key);
  }

  /**
   * `SCAN MATCH` pattern covering every counter under `prefix`.
   *
   * The whole literal is escaped and only then extended by OUR wildcard, so the pattern matches
   * exactly the keys {@link RedisRateLimitStore.redisKey} writes — including the `keyPrefix` and
   * namespace segments, which a project's `redis.keyPrefix` could equally carry a `*` into.
   */
  protected redisKeyPattern(prefix: string): string {
    return `${escapeGlob(this.redisKey(prefix))}*`;
  }

  /**
   * Counter of distinct keys created in the current window.
   *
   * It carries the window as its own TTL and is never refreshed, so the cap means "at most
   * `maxKeys` NEW counters per window" and heals by itself: since every counter also lives one
   * window, that bounds the live keyspace at roughly `maxKeys` rather than capping it forever.
   *
   * The `#meta` segment sits under the namespace prefix so `clear()` sweeps it along with the
   * counters. It is NOT unforgeable: {@link rateLimitKey} escapes a colon inside a part but joins
   * the parts with a real one, so `rateLimitKey('#meta', 'cardinality')` reproduces this key
   * exactly. That costs nothing — the counter it would land on is the one every fresh key
   * increments anyway, and the cap it feeds fails towards COARSER limits, never towards none.
   */
  protected cardinalityKey(): string {
    return this.redisService.key('rate-limit', this.namespace, '#meta', 'cardinality');
  }

  /** Shared coarse counter a key falls into once the namespace is saturated */
  protected overflowKey(key: string): string {
    return this.redisService.key('rate-limit', this.namespace, '#overflow', String(overflowSlot(key)));
  }

  protected async deleteByPattern(pattern: string): Promise<void> {
    const client = this.redisService.getClient();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      if (keys.length) {
        await client.del(...keys);
      }
      cursor = nextCursor;
    } while (cursor !== '0');
  }
}
