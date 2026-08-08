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

  it('reclaims expired entries at capacity', async () => {
    for (let i = 0; i < 5; i++) {
      await store.hit(`key-${i}`, 60);
    }
    expect(store.size()).toBe(5);

    // Once the window passes, the space is genuinely free and a new client is counted normally
    vi.advanceTimersByTime(61_000);
    expect((await store.hit('key-new', 60)).count).toBe(1);
    expect((await store.hit('key-new', 60)).count).toBe(2);
    expect(store.size()).toBeLessThanOrEqual(5);
  });

  it('still counts callers that do not fit, instead of waving them through', async () => {
    // Refusing to STORE an entry at capacity must not mean refusing to COUNT it. Returning an
    // uncounted 1 for every unknown key hands an attacker a total bypass for the price of filling
    // the store: from then on every fresh key is a first request, so the limit never trips again.
    // Both key parts are caller-influenced (a spoofable X-Forwarded-For and the request path), so
    // filling it costs nothing. Overflow callers share coarse buckets — throttled earlier than
    // their own traffic warrants, which is the safe direction to fail.
    for (let i = 0; i < 5; i++) {
      await store.hit(`filler-${i}`, 60);
    }
    expect(store.size()).toBe(5);

    // Same overflowing caller, repeatedly: the count MUST climb.
    const counts: number[] = [];
    for (let i = 0; i < 4; i++) {
      counts.push((await store.hit('overflow-caller', 60)).count);
    }
    expect(counts).toEqual([1, 2, 3, 4]);

    // And a flood of DISTINCT unknown keys must not each start at 1 forever — they are folded
    // into a bounded set of shared counters, so the totals keep rising across the flood.
    const floodCounts = [];
    for (let i = 0; i < 300; i++) {
      floodCounts.push((await store.hit(`flood-${i}`, 60)).count);
    }
    expect(Math.max(...floodCounts)).toBeGreaterThan(1);

    // The overflow space itself stays bounded — it must not become the growth it prevents.
    expect(store.size()).toBeLessThanOrEqual(5);
  });

  it('never evicts a LIVE counter to make room', async () => {
    // Evicting the entries closest to expiry looks like sensible cache behavior and is the
    // opposite of what a rate limiter needs: those are ACTIVE counters, so dropping them resets
    // the window of whoever is being limited — which is precisely the caller flooding the store.
    // An attacker who exhausts their own limit could then clear it by inventing 10k identities.
    for (let i = 0; i < 5; i++) {
      await store.hit('victim', 60);
    }
    expect((await store.hit('victim', 60)).count).toBe(6);

    // Fill every remaining slot with live entries, then push well past the cap
    for (let i = 0; i < 20; i++) {
      await store.hit(`flood-${i}`, 60);
    }

    // The victim's counter survived and kept counting — it was never reset
    expect((await store.hit('victim', 60)).count).toBe(7);
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
        keys.forEach((key) => counters.delete(key));
        return keys.length;
      }),
      eval: vi.fn(async (_script: string, _numKeys: number, key: string, windowSeconds: number) => {
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return [count, Number(windowSeconds)];
      }),
      scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
        const regex = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
        return ['0', [...counters.keys()].filter((key) => regex.test(key))];
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

  it('keeps counting on a per-replica fallback when Redis is unreachable', async () => {
    // Neither alternative is acceptable for a rate limiter: letting the error escape turns
    // a Redis blip into a 500 on every sign-in, and swallowing it into "allowed" deletes
    // the brute-force protection outright. Degrading to the in-memory counter keeps a real
    // bound — the one that applied before Redis existed.
    const { client, store } = createStore();
    client.eval.mockRejectedValue(new Error('ECONNREFUSED'));

    const first = await store.hit('1.2.3.4:sign-in', 60);
    const second = await store.hit('1.2.3.4:sign-in', 60);

    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
  });

  it('resumes shared counting once Redis recovers', async () => {
    const { client, store } = createStore();
    client.eval.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await store.hit('ip:endpoint', 60);
    const recovered = await store.hit('ip:endpoint', 60);

    // Back on Redis, whose counter started fresh — the point is that it is used again
    expect(recovered.count).toBe(1);
    expect(client.eval).toHaveBeenCalledTimes(2);
  });

  it('returns the SHARED counter, so a limiter built on it actually blocks', async () => {
    // The one property that makes this store worth having: the count must be Redis's
    // running total, not a per-call constant. A store that always answered 1 would pass
    // every "first hit is allowed" test while silently never blocking anything — the
    // limiter would look present and enforce nothing.
    const { store } = createStore();

    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      counts.push((await store.hit('1.2.3.4:sign-in', 60)).count);
    }

    expect(counts).toEqual([1, 2, 3, 4, 5]);

    // A different key keeps its own counter
    expect((await store.hit('5.6.7.8:sign-in', 60)).count).toBe(1);
  });

  it('escapes glob metacharacters so a reset cannot reach other callers keys', async () => {
    // The key embeds caller-controlled data. An unescaped `*` would make resetByPrefix
    // clear every other client's counters as well.
    const { client, store } = createStore();
    await store.hit('*:sign-in', 60);

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      1,
      'test-prefix:rate-limit:better-auth:\\*:sign-in',
      60,
    );
  });
});
