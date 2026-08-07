import type { CoreRedisService } from './core-redis.service';

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
}

/**
 * Process-local fixed-window store (previous behavior of all framework rate
 * limiters). Entries are capped and cleaned up periodically.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  protected readonly store = new Map<string, { count: number; resetTime: number }>();
  protected cleanupInterval: NodeJS.Timeout | null = null;

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
        this.evictOldest();
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
    this.removeExpired();
    if (this.store.size >= this.maxEntries) {
      const targetSize = Math.floor(this.maxEntries * 0.9);
      const entries = [...this.store.entries()].sort((a, b) => a[1].resetTime - b[1].resetTime);
      for (const [key] of entries) {
        if (this.store.size <= targetSize) {
          break;
        }
        this.store.delete(key);
      }
    }
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
  constructor(
    protected readonly redisService: CoreRedisService,
    protected readonly namespace: string,
  ) {}

  async clear(): Promise<void> {
    await this.deleteByPattern(this.redisKey('*'));
  }

  async hit(key: string, windowSeconds: number): Promise<RateLimitStoreHit> {
    const client = this.redisService.getClient();
    const [count, ttl] = (await client.eval(HIT_SCRIPT, 1, this.redisKey(key), windowSeconds)) as [number, number];
    return { count, resetIn: ttl };
  }

  async resetByPrefix(prefix: string): Promise<void> {
    await this.deleteByPattern(`${this.redisKey(prefix)}*`);
  }

  size(): number {
    return -1;
  }

  protected redisKey(key: string): string {
    return this.redisService.key('rate-limit', this.namespace, key);
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
