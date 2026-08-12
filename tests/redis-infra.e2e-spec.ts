import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreRedisService } from '../src/core/common/services/core-redis.service';
import { rateLimitKey, rateLimitKeyPrefix, RedisRateLimitStore } from '../src/core/common/services/rate-limit-store';

import type { ConfigService } from '../src/core/common/services/config.service';

/**
 * Round-trip tests against a REAL Redis (localhost:6380, logical db 15).
 * Locally this is the dedicated no-auth test container; in CI the ci-redis
 * service is mapped to the same port. Port 6379 is deliberately avoided —
 * on lt dev machines it is occupied by an auth-protected TurboOps Redis.
 * Isolation: dedicated db + unique key prefix per run, cleanup by prefix.
 */
const RUN_PREFIX = `nest-server-e2e-${Date.now()}-p${process.pid}`;

const START_CONTAINER = 'docker run -d --name nest-server-2985-redis -p 6380:6379 redis:7.4-alpine';

function createService(): CoreRedisService {
  const redisConfig = {
    db: 15,
    host: process.env.REDIS_HOST || 'localhost',
    keyPrefix: RUN_PREFIX,
    // Cap the retry budget: without a container ioredis would otherwise retry for
    // ~43s and then fail with an opaque MaxRetriesPerRequestError.
    options: { connectTimeout: 2000, maxRetriesPerRequest: 1, retryStrategy: () => null },
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6380,
  };
  const configService = {
    getFastButReadOnly: (key: string, defaultValue?: unknown) => (key === 'redis' ? redisConfig : defaultValue),
  } as unknown as ConfigService;
  return new CoreRedisService(configService);
}

describe('Redis infrastructure (real Redis)', () => {
  let service: CoreRedisService;

  beforeAll(async () => {
    service = createService();
    await service.onModuleInit();
    try {
      await service.getClient().ping();
    } catch (error) {
      throw new Error(
        `No Redis reachable on ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6380} `
        + `(${error instanceof Error ? error.message : String(error)}). Start the test container:\n  ${START_CONTAINER}`, { cause: error },
      );
    }
  });

  afterAll(async () => {
    // Remove every key this run created, then close connections. Cleanup must never
    // replace the beforeAll error with a follow-up connection failure.
    try {
      const client = service.getClient();
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${RUN_PREFIX}:*`, 'COUNT', 200);
        if (keys.length) {
          await client.del(...keys);
        }
        cursor = next;
      } while (cursor !== '0');
    } catch {
      // Redis unreachable — nothing to clean up
    }
    await service.onApplicationShutdown();
  });

  it('connects, writes and reads with prefixed keys', async () => {
    const client = service.getClient();
    const key = service.key('smoke', 'value');
    await client.set(key, 'hello', 'EX', 60);
    expect(await client.get(key)).toBe('hello');
  });

  it('subscriber connection is separate and receives published messages', async () => {
    const channel = service.key('smoke', 'channel');
    const subscriber = service.getSubscriber();
    const received = new Promise<string>((resolve) => {
      subscriber.on('message', (chan, message) => {
        if (chan === channel) {
          resolve(message);
        }
      });
    });
    await subscriber.subscribe(channel);
    await service.getClient().publish(channel, 'ping');
    expect(await received).toBe('ping');
    await subscriber.unsubscribe(channel);
  });

  describe('RedisRateLimitStore', () => {
    it('counts atomically and expires with the window', async () => {
      const store = new RedisRateLimitStore(service, 'e2e');
      const first = await store.hit('ip:endpoint', 2);
      expect(first.count).toBe(1);
      expect(first.resetIn).toBeGreaterThan(0);
      expect((await store.hit('ip:endpoint', 2)).count).toBe(2);

      // Parallel hits from "several replicas" (same Redis) stay exact
      const parallel = await Promise.all(Array.from({ length: 10 }, () => store.hit('parallel', 60)));
      const counts = parallel.map(hit => hit.count).sort((a, b) => a - b);
      expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // Window expiry resets the counter
      await new Promise(resolve => setTimeout(resolve, 2100));
      expect((await store.hit('ip:endpoint', 2)).count).toBe(1);
    });

    it('resetByPrefix clears only matching keys', async () => {
      const store = new RedisRateLimitStore(service, 'e2e-reset');
      await store.hit('1.2.3.4:sign-in', 60);
      await store.hit('5.6.7.8:sign-in', 60);
      await store.resetByPrefix('1.2.3.4:');
      expect((await store.hit('1.2.3.4:sign-in', 60)).count).toBe(1);
      expect((await store.hit('5.6.7.8:sign-in', 60)).count).toBe(2);
    });

    // The two tests below use rateLimitKey()/rateLimitKeyPrefix() — the construction the limiters
    // themselves use — and run against a real Redis, because the property under test IS Redis's
    // glob semantics. A fake SCAN that translates `*` to `.*` agrees with a store that escapes the
    // key twice, which is exactly how this shipped: reset() silently cleared nothing for every
    // IPv6 caller while reporting success, and only on the Redis store, so single-replica setups
    // (in-memory fallback, plain `startsWith`) never saw it.
    const KEY_SHAPES = ['1.2.3.4', '::1', '::ffff:127.0.0.1', '2001:db8::42', 'a*b[c'];

    // Counters live for a full window, so a retried attempt must not inherit the previous one's
    // state — every attempt takes its own namespace.
    let shapeRun = 0;

    it.each(KEY_SHAPES)('resetByPrefix actually clears the counter for %j', async (ip) => {
      const store = new RedisRateLimitStore(service, `e2e-shape-${shapeRun++}`);
      const key = rateLimitKey(ip, 'signIn');

      expect((await store.hit(key, 60)).count).toBe(1);
      expect((await store.hit(key, 60)).count).toBe(2);

      await store.resetByPrefix(rateLimitKeyPrefix(ip));

      // A no-op reset would answer 3 here — and an admin unblock would have reported success.
      expect((await store.hit(key, 60)).count).toBe(1);
    });

    it('resetByPrefix does not sweep neighbouring counters, whatever the key contains', async () => {
      // The other direction: a glob metacharacter in a caller-controlled part must not widen the
      // pattern into everyone else's counters.
      const store = new RedisRateLimitStore(service, `e2e-shape-scope-${shapeRun++}`);
      for (const ip of KEY_SHAPES) {
        expect((await store.hit(rateLimitKey(ip, 'signIn'), 60)).count).toBe(1);
      }

      await store.resetByPrefix(rateLimitKeyPrefix('a*b[c'));

      expect((await store.hit(rateLimitKey('a*b[c', 'signIn'), 60)).count).toBe(1);
      for (const other of KEY_SHAPES.filter(ip => ip !== 'a*b[c')) {
        expect((await store.hit(rateLimitKey(other, 'signIn'), 60)).count).toBe(2);
      }
    });
  });
});
