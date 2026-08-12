import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreRedisService } from '../src/core/common/services/core-redis.service';
import { HubBuffer } from '../src/core/modules/hub/hub-buffer';

import type { HubBufferEntry } from '../src/core/modules/hub/hub-ring-buffer';
import { TusRedisLocker } from '../src/core/modules/tus/tus-redis-locker';

import type { ConfigService } from '../src/core/common/services/config.service';

/**
 * The Redis consumers that had no fleet-level proof.
 *
 * `redis-infra` covers the transport, `multi-replica` covers cron dedup and rate
 * limiting. These three were left over: the tus lock (flagged as untested in the
 * PR itself), the tenant-cache invalidation broadcast, and the Hub buffer mirror.
 *
 * All of them share one property that only a REAL Redis can demonstrate: two
 * INDEPENDENT service instances — standing in for two replicas — must see each
 * other's effects. A mock proves the call was made; it cannot prove the second
 * replica observed it, which is the entire point of moving the state to Redis.
 *
 * Requires the Redis container (started automatically by tests/global-setup.ts).
 */
const RUN_ID = `redis-consumers-${Date.now()}-p${process.pid}`;
const PORT = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6380;

function createRedis(): CoreRedisService {
  return new CoreRedisService({
    getFastButReadOnly: (key: string) =>
      key === 'redis'
        ? { db: 15, host: 'localhost', keyPrefix: RUN_ID, options: { maxRetriesPerRequest: 1 }, port: PORT }
        : undefined,
  } as unknown as ConfigService);
}

/** Two independent services = two replicas sharing one Redis. */
let replicaA: CoreRedisService;
let replicaB: CoreRedisService;

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

describe('Redis consumers across replicas (real Redis)', () => {
  beforeAll(async () => {
    replicaA = createRedis();
    replicaB = createRedis();
    try {
      await replicaA.onModuleInit();
      await replicaB.onModuleInit();
    } catch (error) {
      throw new Error(
        `This suite needs a Redis on localhost:${PORT}. Run: pnpm run test:infra `
          + `(${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
  }, 60_000);

  afterAll(async () => {
    try {
      const client = replicaA.getClient();
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${RUN_ID}*`, 'COUNT', 300);
        if (keys.length) {
          await client.del(...keys);
        }
        cursor = next;
      } while (cursor !== '0');
    } catch {
      // Nothing to clean up
    }
    await replicaA?.onApplicationShutdown();
    await replicaB?.onApplicationShutdown();
  }, 60_000);

  describe('TusRedisLocker', () => {
    it('holds an upload exclusively ACROSS replicas', async () => {
      // Without this the in-process default locker lets two replicas each hold
      // "the" lock for one upload id and interleave byte ranges into it.
      const lockA = new TusRedisLocker(replicaA).newLock('upload-1');
      const lockB = new TusRedisLocker(replicaB, 30_000, 300).newLock('upload-1');

      await lockA.lock(new AbortController().signal, async () => undefined);

      // The second replica cannot take it while A holds it.
      await expect(lockB.lock(new AbortController().signal, async () => undefined)).rejects.toThrow();

      await lockA.unlock();

      // …and can once A lets go.
      await lockB.lock(new AbortController().signal, async () => undefined);
      await lockB.unlock();
    }, 30_000);

    it('asks the current holder to hand over, rather than only waiting it out', async () => {
      // The tus handover mechanism, and it is easy to get backwards: `cancelReq`
      // belongs to the WAITER, not the holder. The waiter invokes it on every
      // attempt to tell the server "someone wants this upload"; the server then
      // makes the holding request let go. Without it a second replica could only
      // wait out the TTL, so a legitimate resume would stall for 30s.
      const lockA = new TusRedisLocker(replicaA).newLock('upload-2');
      const lockB = new TusRedisLocker(replicaB, 30_000, 3000).newLock('upload-2');

      await lockA.lock(new AbortController().signal, async () => undefined);

      let handoverRequested = false;
      await lockB.lock(new AbortController().signal, async () => {
        // Stands in for what @tus/server does with the signal: end the holder's request.
        handoverRequested = true;
        await lockA.unlock();
      });

      expect(handoverRequested).toBe(true);
      await lockB.unlock();
    }, 30_000);

    it('frees an upload whose holder died, instead of wedging it forever', async () => {
      // Short TTL stands in for "the holder's process went away and stopped
      // heartbeating". Without expiry a crashed replica would block an upload id
      // until someone intervened by hand.
      const shortLived = new TusRedisLocker(replicaA, 300, 5000).newLock('upload-3');
      await shortLived.lock(new AbortController().signal, async () => undefined);

      const key = replicaA.key('tus-lock', 'upload-3');
      expect(await replicaA.getClient().exists(key)).toBe(1);

      // Drop the heartbeat the way a dead process would, then let the TTL lapse.
      await (shortLived as unknown as { stopHeartbeat?: () => void }).stopHeartbeat?.();
      clearInterval((shortLived as unknown as { heartbeat?: NodeJS.Timeout }).heartbeat);

      expect(await waitFor(async () => (await replicaA.getClient().exists(key)) === 0, 3000)).toBe(true);

      const other = new TusRedisLocker(replicaB, 30_000, 1000).newLock('upload-3');
      await other.lock(new AbortController().signal, async () => undefined);
      await other.unlock();
    }, 30_000);
  });

  describe('tenant cache invalidation', () => {
    it('reaches the OTHER replica through the shared subscriber', async () => {
      // The failure this prevents: a membership change on replica A leaves B
      // serving the stale role until its TTL lapses — i.e. a revoked member keeps
      // access for up to the cache lifetime.
      const channel = replicaA.key('tenant-cache', 'invalidate');
      const received: string[] = [];

      const subscriber = replicaB.getSubscriber();
      subscriber.on('message', (incoming: string, message: string) => {
        if (incoming === channel) {
          received.push(message);
        }
      });
      await subscriber.subscribe(channel);

      await replicaA.getClient().publish(channel, 'user-42');

      expect(await waitFor(() => received.includes('user-42'))).toBe(true);
      await subscriber.unsubscribe(channel);
    }, 30_000);

    it('uses a namespaced channel, so two deployments on one Redis do not cross-invalidate', () => {
      expect(replicaA.key('tenant-cache', 'invalidate')).toContain(RUN_ID);
    });
  });

  describe('Hub buffer mirror', () => {
    interface LogEntry extends HubBufferEntry {
      message: string;
    }

    it('makes an entry appended on one replica visible to the other', async () => {
      // Without the mirror the Hub only ever shows the pod that happened to
      // answer the request — which is exactly when an operator needs the others.
      const name = `logs-${Math.random().toString(36).substring(7)}`;
      const bufferA = new HubBuffer<LogEntry>(50, name, replicaA);
      const bufferB = new HubBuffer<LogEntry>(50, name, replicaB);

      bufferA.add({ message: 'from replica A' } as Omit<LogEntry, 'seq' | 'timestamp'>);

      expect(
        await waitFor(async () => (await bufferB.read()).entries.some(entry => entry.message === 'from replica A')),
      ).toBe(true);
    }, 30_000);

    it('keeps sequence numbers meaningful across replicas', async () => {
      // Two replicas appending to one buffer must not both hand out seq 0 —
      // a client paging by cursor would silently skip one of them.
      const name = `logs-seq-${Math.random().toString(36).substring(7)}`;
      const bufferA = new HubBuffer<LogEntry>(50, name, replicaA);
      const bufferB = new HubBuffer<LogEntry>(50, name, replicaB);

      bufferA.add({ message: 'a1' } as Omit<LogEntry, 'seq' | 'timestamp'>);
      bufferB.add({ message: 'b1' } as Omit<LogEntry, 'seq' | 'timestamp'>);

      const reached = await waitFor(async () => {
        const seen = (await bufferA.read()).entries.map(entry => entry.message);
        return seen.includes('a1') && seen.includes('b1');
      });
      expect(reached).toBe(true);

      const seqs = (await bufferA.read()).entries.map(entry => entry.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
    }, 30_000);

    it('survives Redis being unavailable instead of taking the request down', async () => {
      // The mirror is fire-and-forget by design: an observability feature must
      // never fail the request it is observing.
      const severed = createRedis();
      const buffer = new HubBuffer<LogEntry>(10, 'logs-severed', severed);

      expect(() => buffer.add({ message: 'no redis here' } as Omit<LogEntry, 'seq' | 'timestamp'>)).not.toThrow();
      expect((await buffer.read()).entries.map(entry => entry.message)).toContain('no redis here');
      await severed.onApplicationShutdown();
    }, 30_000);
  });
});
