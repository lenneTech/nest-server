import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InMemoryRateLimitStore,
  rateLimitKey,
  rateLimitKeyPrefix,
  RedisRateLimitStore,
} from '../../src/core/common/services/rate-limit-store';

import type { CoreRedisService } from '../../src/core/common/services/core-redis.service';

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

  it('clear also drops the overflow buckets', async () => {
    // The overflow map is bounded, so leaving it behind cannot leak — but it still holds live
    // counts. A test that clears the store and then sees a limit trip early is looking at counters
    // it believes it deleted.
    for (let i = 0; i < 5; i++) {
      await store.hit(`filler-${i}`, 60);
    }
    expect((await store.hit('overflow-caller', 60)).count).toBe(1);
    expect((await store.hit('overflow-caller', 60)).count).toBe(2);

    await store.clear();
    expect((await store.hit('overflow-caller', 60)).count).toBe(1);
  });
});

describe('RedisRateLimitStore', () => {
  /**
   * Translate a Redis `SCAN MATCH` pattern the way Redis itself does (`stringmatchlen`): `\x` is a
   * LITERAL x, `*` any run, `?` one character, `[...]` a class.
   *
   * The escape handling is the part that matters. A fake that merely rewrites `*` to `.*` treats
   * `\*` as "backslash, then any run" and therefore happily matches a key that carries the escape
   * backslash literally — so it AGREES with a store that escapes the key on the way in and the
   * pattern on the way out. That is precisely how a reset broke for every IPv6 caller with this
   * suite green. Real semantics here, plus the round-trip in `tests/redis-infra.e2e-spec.ts`.
   */
  function globToRegExp(pattern: string): RegExp {
    const literal = (char: string) => char.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      if (char === '\\' && i + 1 < pattern.length) {
        source += literal(pattern[++i]);
      } else if (char === '*') {
        source += '.*';
      } else if (char === '?') {
        source += '.';
      } else if (char === '[' || char === ']') {
        source += char;
      } else {
        source += literal(char);
      }
    }
    return new RegExp(`^${source}$`);
  }

  /**
   * Minimal fake client implementing the eval/scan/del surface the store uses.
   *
   * `eval` mirrors the semantics of HIT_SCRIPT: three keys (counter, per-namespace cardinality,
   * overflow bucket) and two arguments (window, cap). The cardinality branch is what bounds the
   * keyspace, so the fake has to model it — a fake that only ever incremented KEYS[1] would pass
   * while the store had no bound at all.
   */
  function createFakeRedis() {
    const counters = new Map<string, number>();
    return {
      counters,
      del: vi.fn(async (...keys: string[]) => {
        keys.forEach((key) => counters.delete(key));
        return keys.length;
      }),
      eval: vi.fn(async (_script: string, numKeys: number, ...rest: unknown[]) => {
        const [key, cardinalityKey, overflowKey] = rest.slice(0, numKeys) as string[];
        const [windowSeconds, maxKeys] = rest.slice(numKeys) as number[];
        let target = key;
        let overflow = 0;
        if (!counters.has(key)) {
          const seen = (counters.get(cardinalityKey) ?? 0) + 1;
          counters.set(cardinalityKey, seen);
          if (seen > Number(maxKeys)) {
            target = overflowKey;
            overflow = 1;
          }
        }
        const count = (counters.get(target) ?? 0) + 1;
        counters.set(target, count);
        return [count, Number(windowSeconds), overflow];
      }),
      scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
        const regex = globToRegExp(pattern);
        return ['0', [...counters.keys()].filter((key) => regex.test(key))];
      }),
    };
  }

  function createStore(maxKeys?: number) {
    const client = createFakeRedis();
    const redisService = {
      getClient: () => client,
      key: (...parts: string[]) => ['test-prefix', ...parts].join(':'),
    } as unknown as CoreRedisService;
    return { client, store: new RedisRateLimitStore(redisService, 'better-auth', maxKeys) };
  }

  it('hits via atomic eval with namespaced key', async () => {
    const { client, store } = createStore();
    const result = await store.hit('1.2.3.4:sign-in', 60);
    expect(result).toEqual({ count: 1, resetIn: 60 });
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      3,
      'test-prefix:rate-limit:better-auth:1.2.3.4:sign-in',
      'test-prefix:rate-limit:better-auth:#meta:cardinality',
      expect.stringContaining('test-prefix:rate-limit:better-auth:#overflow:'),
      60,
      10000,
    );
    expect((await store.hit('1.2.3.4:sign-in', 60)).count).toBe(2);
  });

  it('bounds the keyspace instead of INCRing whatever the caller names', async () => {
    // Both parts of a key are caller-influenced, so an unbounded INCR is an unbounded write
    // primitive against the Redis instance that also holds cron leases, MCP session ownership and
    // the Hub buffers. The in-memory store has always defended against this; the Redis one must
    // not drop that defense just because `redis` is configured. As there, the right failure is a
    // COARSER limit for new clients — never an uncounted 1 per fresh key, which is a total bypass.
    const { store } = createStore(3);

    for (let i = 0; i < 3; i++) {
      expect((await store.hit(`known-${i}`, 60)).count).toBe(1);
    }

    // Past the cap, distinct new keys are folded into shared counters — so the totals keep rising
    // across the flood instead of resetting to 1 each time.
    const flood: number[] = [];
    for (let i = 0; i < 300; i++) {
      flood.push((await store.hit(`flood-${i}`, 60)).count);
    }
    expect(Math.max(...flood)).toBeGreaterThan(1);

    // Counters that existed before saturation keep their own exact count.
    expect((await store.hit('known-0', 60)).count).toBe(2);
  });

  it('uses the registered command instead of shipping the script when the client supports it', async () => {
    // defineCommand sends EVALSHA and only falls back to the body on NOSCRIPT, rather than pushing
    // the whole Lua source on every single request.
    const defined = new Map<string, { lua: string; numberOfKeys: number }>();
    const client: any = {
      defineCommand: vi.fn((name: string, options: { lua: string; numberOfKeys: number }) => {
        defined.set(name, options);
        client[name] = vi.fn(async () => [1, 60, 0]);
      }),
      eval: vi.fn(),
    };
    const redisService = {
      getClient: () => client,
      key: (...parts: string[]) => ['test-prefix', ...parts].join(':'),
    } as unknown as CoreRedisService;
    const store = new RedisRateLimitStore(redisService, 'better-auth');

    expect(await store.hit('1.2.3.4:sign-in', 60)).toEqual({ count: 1, resetIn: 60 });
    await store.hit('1.2.3.4:sign-in', 60);

    expect(client.eval).not.toHaveBeenCalled();
    expect(client.defineCommand).toHaveBeenCalledTimes(1);
    expect(defined.get('ltRateLimitHit')?.numberOfKeys).toBe(3);
  });

  it('resetByPrefix scans and deletes matching keys only', async () => {
    const { client, store } = createStore();
    await store.hit('1.2.3.4:sign-in', 60);
    await store.hit('5.6.7.8:sign-in', 60);
    await store.resetByPrefix('1.2.3.4:');
    // `#meta:cardinality` is the framework's own keyspace bound and survives a per-IP reset by
    // design — resetting one client must not hand an attacker a way to clear the cap as well.
    expect([...client.counters.keys()]).toEqual([
      'test-prefix:rate-limit:better-auth:#meta:cardinality',
      'test-prefix:rate-limit:better-auth:5.6.7.8:sign-in',
    ]);
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

  it('stores the key literally and escapes only the scan pattern', async () => {
    // Escape ONCE. The key is data — it goes to Redis as-is; only the SCAN pattern is a glob and
    // therefore the only place a caller-controlled `*` has to be neutralised. Escaping both left
    // the stored key carrying the backslashes literally while the pattern's `\x` matched a single
    // unescaped `x`, so the two never met again and resetByPrefix cleared nothing.
    const { client, store } = createStore();
    await store.hit('*:sign-in', 60);

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      3,
      'test-prefix:rate-limit:better-auth:*:sign-in',
      expect.any(String),
      expect.any(String),
      60,
      10000,
    );

    await store.resetByPrefix('*:');
    expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', 'test-prefix:rate-limit:better-auth:\\*:*', 'COUNT', 200);
  });

  it('round-trips a reset for keys carrying a separator escape or a glob metacharacter', async () => {
    // Every IPv6 address makes rateLimitKey emit `\:`, so this is the ordinary case, not an exotic
    // one — and it is invisible to the in-memory fallback, which compares with startsWith.
    const { store } = createStore();
    const shapes = ['1.2.3.4', '::1', '::ffff:127.0.0.1', '2001:db8::42', 'a*b[c'];

    for (const ip of shapes) {
      const key = rateLimitKey(ip, 'signIn');
      expect((await store.hit(key, 60)).count).toBe(1);
      expect((await store.hit(key, 60)).count).toBe(2);

      await store.resetByPrefix(rateLimitKeyPrefix(ip));

      // A no-op reset answers 3 here — which is what an admin unblock reported success for.
      expect((await store.hit(key, 60)).count).toBe(1);
    }
  });

  it('a reset stays inside its own prefix even when the key contains a glob metacharacter', async () => {
    const { store } = createStore();
    const shapes = ['1.2.3.4', '::1', 'a*b[c'];
    for (const ip of shapes) {
      await store.hit(rateLimitKey(ip, 'signIn'), 60);
    }

    await store.resetByPrefix(rateLimitKeyPrefix('a*b[c'));

    expect((await store.hit(rateLimitKey('a*b[c', 'signIn'), 60)).count).toBe(1);
    expect((await store.hit(rateLimitKey('1.2.3.4', 'signIn'), 60)).count).toBe(2);
    expect((await store.hit(rateLimitKey('::1', 'signIn'), 60)).count).toBe(2);
  });
});

describe('rateLimitKey', () => {
  it('keeps caller-controlled parts from straddling the segment separator', () => {
    // `:` separates every segment of a framework key, so plain concatenation let a caller aim at
    // someone else's counter: an IP of "1.2.3.4:5" with endpoint "/a" produced the same key as IP
    // "1.2.3.4" with endpoint "5:/a". Every IPv6 address contains colons, so this is not exotic.
    expect(rateLimitKey('1.2.3.4:5', '/a')).not.toBe(rateLimitKey('1.2.3.4', '5:/a'));
    expect(rateLimitKey('1.2.3.4', 'signIn')).toBe('1.2.3.4:signIn');
  });

  it('cannot be forged with a literal backslash', () => {
    // Escaping `:` without first escaping `\` would let a part end in a backslash and neutralize
    // the escape of the separator that follows it.
    expect(rateLimitKey('a\\', 'b')).not.toBe(rateLimitKey('a', ':b'));
  });

  it('builds a reset prefix that stops at the separator', () => {
    // Without the trailing real separator, resetting "1.2.3.4" would also clear "1.2.3.40".
    expect(rateLimitKeyPrefix('1.2.3.4')).toBe('1.2.3.4:');
    expect(rateLimitKey('1.2.3.40', 'signIn').startsWith(rateLimitKeyPrefix('1.2.3.4'))).toBe(false);
  });
});
