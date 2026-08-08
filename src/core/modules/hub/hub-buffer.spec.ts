import { describe, expect, it } from 'vitest';

import { HubBuffer } from './hub-buffer';
import { HubBufferEntry } from './hub-ring-buffer';

interface TestEntry extends HubBufferEntry {
  message: string;
}

/**
 * Minimal ioredis double: a single list plus a counter, driven through the same
 * MULTI/LPUSH/LTRIM/GET/LRANGE/DEL surface the real client exposes.
 */
function makeRedis() {
  const counters = new Map<string, number>();
  const lists = new Map<string, string[]>();
  const client = {
    del: async (key: string) => {
      lists.delete(key);
      return 1;
    },
    multi() {
      const ops: (() => void)[] = [];
      const results: [null, unknown][] = [];
      const chain: any = {
        exec: async () => {
          for (const op of ops) {
            op();
          }
          return results;
        },
        get(key: string) {
          ops.push(() => results.push([null, String(counters.get(key) ?? 0)]));
          return chain;
        },
        incr(key: string) {
          ops.push(() => {
            counters.set(key, (counters.get(key) ?? 0) + 1);
            results.push([null, counters.get(key)]);
          });
          return chain;
        },
        lpush(key: string, value: string) {
          ops.push(() => {
            const list = lists.get(key) ?? [];
            list.unshift(value);
            lists.set(key, list);
            results.push([null, list.length]);
          });
          return chain;
        },
        lrange(key: string, start: number, stop: number) {
          ops.push(() => {
            const list = lists.get(key) ?? [];
            results.push([null, stop === -1 ? [...list] : list.slice(start, stop + 1)]);
          });
          return chain;
        },
        ltrim(key: string, start: number, stop: number) {
          ops.push(() => {
            lists.set(key, (lists.get(key) ?? []).slice(start, stop + 1));
            results.push([null, 'OK']);
          });
          return chain;
        },
      };
      return chain;
    },
  };
  const redis: any = {
    enabled: true,
    getClient: () => client,
    key: (...parts: string[]) => ['nest-server', ...parts].join(':'),
  };
  return { lists, redis };
}

/** Appends are fire-and-forget; let the queued promises settle before reading. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('HubBuffer', () => {
  describe('without Redis (unchanged, process-local)', () => {
    it('round-trips entries with cursor and dropped', async () => {
      const buffer = new HubBuffer<TestEntry>(10, 'logs');
      buffer.add({ message: 'a' });
      buffer.add({ message: 'b' });

      const data = await buffer.read();
      expect(data.entries.map((e) => e.message)).toEqual(['a', 'b']);
      expect(data.cursor).toBe(1);
      expect(data.dropped).toBe(0);
    });

    it('supports since-cursor polling and clear()', async () => {
      const buffer = new HubBuffer<TestEntry>(10, 'logs');
      buffer.add({ message: 'a' });
      const cursor = (await buffer.read()).cursor;
      buffer.add({ message: 'b' });

      expect((await buffer.read(cursor)).entries.map((e) => e.message)).toEqual(['b']);
      buffer.clear();
      expect((await buffer.read()).entries).toHaveLength(0);
    });
  });

  describe('with Redis (shared across replicas)', () => {
    it('appends to the shared list and reads it back oldest→newest', async () => {
      const { redis } = makeRedis();
      const buffer = new HubBuffer<TestEntry>(10, 'logs', redis);
      buffer.add({ message: 'a' });
      buffer.add({ message: 'b' });
      await settle();

      const data = await buffer.read();
      expect(data.entries.map((e) => e.message)).toEqual(['a', 'b']);
      // Seq is derived from the shared counter, so it is comparable across replicas.
      expect(data.entries.map((e) => e.seq)).toEqual([0, 1]);
      expect(data.cursor).toBe(1);
      expect(data.dropped).toBe(0);
    });

    it('reads entries written by ANOTHER replica (the whole point)', async () => {
      const { redis } = makeRedis();
      const replicaA = new HubBuffer<TestEntry>(10, 'logs', redis);
      const replicaB = new HubBuffer<TestEntry>(10, 'logs', redis);
      replicaA.add({ message: 'from-a' });
      replicaB.add({ message: 'from-b' });
      await settle();

      expect((await replicaA.read()).entries.map((e) => e.message)).toEqual(['from-a', 'from-b']);
      expect((await replicaB.read()).entries.map((e) => e.message)).toEqual(['from-a', 'from-b']);
    });

    it('enforces the capacity cap via LTRIM and reports the eviction gap', async () => {
      const { lists, redis } = makeRedis();
      const buffer = new HubBuffer<TestEntry>(3, 'logs', redis);
      for (const message of ['a', 'b', 'c', 'd', 'e']) {
        buffer.add({ message });
      }
      await settle();

      expect(lists.get('nest-server:hub:logs')).toHaveLength(3);
      const data = await buffer.read();
      expect(data.entries.map((e) => e.message)).toEqual(['c', 'd', 'e']);
      expect(data.cursor).toBe(4);
      expect(data.dropped).toBe(2);
    });

    it('filters by the shared cursor on since-polling', async () => {
      const { redis } = makeRedis();
      const buffer = new HubBuffer<TestEntry>(10, 'logs', redis);
      buffer.add({ message: 'a' });
      await settle();
      const cursor = (await buffer.read()).cursor;
      buffer.add({ message: 'b' });
      await settle();

      expect((await buffer.read(cursor)).entries.map((e) => e.message)).toEqual(['b']);
    });

    it('clear() deletes the shared list but keeps cursors valid', async () => {
      const { redis } = makeRedis();
      const buffer = new HubBuffer<TestEntry>(10, 'logs', redis);
      buffer.add({ message: 'a' });
      buffer.add({ message: 'b' });
      await settle();
      buffer.clear();
      await settle();

      const data = await buffer.read();
      expect(data.entries).toHaveLength(0);
      // The counter is NOT reset, so a client cursor of 1 is still in the past.
      expect(data.cursor).toBe(1);
      expect(data.dropped).toBe(-1);
    });

    it('falls back to the local buffer when Redis reads fail', async () => {
      const { redis } = makeRedis();
      const buffer = new HubBuffer<TestEntry>(10, 'logs', redis);
      buffer.add({ message: 'a' });
      await settle();
      redis.getClient = () => {
        throw new Error('connection lost');
      };

      expect((await buffer.read()).entries.map((e) => e.message)).toEqual(['a']);
    });
  });
});
