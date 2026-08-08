import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreRedisService } from '../src/core/common/services/core-redis.service';
import { RedisRateLimitStore } from '../src/core/common/services/rate-limit-store';

import type { ConfigService } from '../src/core/common/services/config.service';

/**
 * Round-trip tests against a REAL Redis (localhost:6380, logical db 15).
 * Locally this is the dedicated no-auth test container; in CI the ci-redis
 * service is mapped to the same port. Port 6379 is deliberately avoided —
 * on lt dev machines it is occupied by an auth-protected TurboOps Redis.
 * Isolation: dedicated db + unique key prefix per run, cleanup by prefix.
 */
const RUN_PREFIX = `nest-server-e2e-${Date.now()}-p${process.pid}`;

function createService(): CoreRedisService {
  const redisConfig = {
    db: 15,
    host: process.env.REDIS_HOST || 'localhost',
    keyPrefix: RUN_PREFIX,
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
    await service.getClient().ping();
  });

  afterAll(async () => {
    // Remove every key this run created, then close connections
    const client = service.getClient();
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${RUN_PREFIX}:*`, 'COUNT', 200);
      if (keys.length) {
        await client.del(...keys);
      }
      cursor = next;
    } while (cursor !== '0');
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
  });
});
