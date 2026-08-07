import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRateLimitStore, RedisRateLimitStore } from './rate-limit-store';

import type { CoreRedisService } from './core-redis.service';

describe('InMemoryRateLimitStore', () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryRateLimitStore(5);
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it('counts hits within the window', async () => {
    expect(await store.hit('a', 60)).toEqual({ count: 1, resetIn: 60 });
    expect((await store.hit('a', 60)).count).toBe(2);
    expect((await store.hit('b', 60)).count).toBe(1);
  });

  it('resets the counter after the window elapses', async () => {
    await store.hit('a', 60);
    vi.advanceTimersByTime(61_000);
    expect((await store.hit('a', 60)).count).toBe(1);
  });

  it('reports decreasing resetIn within the window', async () => {
    await store.hit('a', 60);
    vi.advanceTimersByTime(30_000);
    expect((await store.hit('a', 60)).resetIn).toBe(30);
  });

  it('evicts when at capacity instead of growing unbounded', async () => {
    for (let i = 0; i < 5; i++) {
      await store.hit(`key-${i}`, 60);
    }
    expect(store.size()).toBe(5);
    await store.hit('key-new', 60);
    expect(store.size()).toBeLessThanOrEqual(5);
    expect((await store.hit('key-new', 60)).count).toBe(2);
  });

  it('resetByPrefix removes only matching keys', async () => {
    await store.hit('1.2.3.4:sign-in', 60);
    await store.hit('1.2.3.4:sign-up', 60);
    await store.hit('5.6.7.8:sign-in', 60);
    await store.resetByPrefix('1.2.3.4:');
    expect((await store.hit('1.2.3.4:sign-in', 60)).count).toBe(1);
    expect((await store.hit('5.6.7.8:sign-in', 60)).count).toBe(2);
  });

  it('clear removes everything', async () => {
    await store.hit('a', 60);
    await store.clear();
    expect(store.size()).toBe(0);
  });
});

describe('RedisRateLimitStore', () => {
  /** Minimal fake client implementing the eval/scan/del surface the store uses */
  function createFakeRedis() {
    const counters = new Map<string, number>();
    return {
      counters,
      del: vi.fn(async (...keys: string[]) => {
        keys.forEach(key => counters.delete(key));
        return keys.length;
      }),
      eval: vi.fn(async (_script: string, _numKeys: number, key: string, windowSeconds: number) => {
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return [count, Number(windowSeconds)];
      }),
      scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
        const regex = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
        return ['0', [...counters.keys()].filter(key => regex.test(key))];
      }),
    };
  }

  function createStore() {
    const client = createFakeRedis();
    const redisService = {
      getClient: () => client,
      key: (...parts: string[]) => ['test-prefix', ...parts].join(':'),
    } as unknown as CoreRedisService;
    return { client, store: new RedisRateLimitStore(redisService, 'better-auth') };
  }

  it('hits via atomic eval with namespaced key', async () => {
    const { client, store } = createStore();
    const result = await store.hit('1.2.3.4:sign-in', 60);
    expect(result).toEqual({ count: 1, resetIn: 60 });
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      1,
      'test-prefix:rate-limit:better-auth:1.2.3.4:sign-in',
      60,
    );
    expect((await store.hit('1.2.3.4:sign-in', 60)).count).toBe(2);
  });

  it('resetByPrefix scans and deletes matching keys only', async () => {
    const { client, store } = createStore();
    await store.hit('1.2.3.4:sign-in', 60);
    await store.hit('5.6.7.8:sign-in', 60);
    await store.resetByPrefix('1.2.3.4:');
    expect([...client.counters.keys()]).toEqual(['test-prefix:rate-limit:better-auth:5.6.7.8:sign-in']);
  });

  it('size is not cheaply known on Redis', () => {
    const { store } = createStore();
    expect(store.size()).toBe(-1);
  });
});
