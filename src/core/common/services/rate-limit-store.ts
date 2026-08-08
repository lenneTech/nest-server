import { Logger } from '@nestjs/common';

import type { CoreRedisService } from './core-redis.service';

/**
 * Escape Redis glob metacharacters in caller-influenced key parts.
 *
 * Keys embed values the caller controls (an IP, an endpoint, an email). Those parts end up
 * both in the key itself and — via `resetByPrefix` — inside a `SCAN MATCH` pattern, where
 * an unescaped `*` or `?` would silently widen the match to other callers' counters.
 */
function escapeGlob(value: string): string {
  return value.replace(/[?[\]*\\^]/g, (char) => `\\${char}`);
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

  constructor(protected readonly maxEntries = 10000) {
    // Clean up expired entries every 5 minutes; never keep the process alive
    this.cleanupInterval = setInterval(() => this.removeExpired(), 5 * 60 * 1000);
    this.cleanupInterval.unref?.();
  }

  async clear(): Promise<void> {
    this.store.clear();
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
              `Rate limit store is at capacity (${this.maxEntries} live counters). New clients are counted from 1 ` +
                'until entries expire; existing limits are unaffected.',
            );
          }
          return { count: 1, resetIn: windowSeconds };
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
 * Atomic INCR + EXPIRE in one round trip. KEYS[1] = counter key,
 * ARGV[1] = window in seconds. Returns [count, ttlSeconds].
 */
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

/**
 * Redis-backed fixed-window store. All replicas share the counters, so the
 * configured limit is enforced exactly regardless of replica count.
 *
 * Keys: `<keyPrefix>:rate-limit:<namespace>:<key>` with the window TTL —
 * no cleanup or eviction needed.
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

  constructor(
    protected readonly redisService: CoreRedisService,
    protected readonly namespace: string,
  ) {}

  async clear(): Promise<void> {
    await this.fallback.clear();
    // The wildcard is OURS, not caller input — routing it through redisKey() would escape it to
    // a literal `\*` that matches nothing, making clear() a no-op against Redis.
    await this.guard(() => this.deleteByPattern(`${this.redisService.key('rate-limit', this.namespace)}:*`), undefined);
  }

  async hit(key: string, windowSeconds: number): Promise<RateLimitStoreHit> {
    return this.guard(
      async () => {
        const client = this.redisService.getClient();
        const [count, ttl] = (await client.eval(HIT_SCRIPT, 1, this.redisKey(key), windowSeconds)) as [number, number];
        if (this.degraded) {
          this.degraded = false;
          this.logger.log('Redis rate limiting recovered — limits are shared across replicas again');
        }
        return { count, resetIn: ttl };
      },
      () => this.fallback.hit(key, windowSeconds),
    );
  }

  async resetByPrefix(prefix: string): Promise<void> {
    await this.fallback.resetByPrefix(prefix);
    await this.guard(() => this.deleteByPattern(`${this.redisKey(prefix)}*`), undefined);
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

  protected redisKey(key: string): string {
    return this.redisService.key('rate-limit', this.namespace, escapeGlob(key));
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
