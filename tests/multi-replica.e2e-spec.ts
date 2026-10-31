import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreRedisService } from '../src/core/common/services/core-redis.service';
import { CoreCronJobs } from '../src/core/common/services/core-cron-jobs.service';
import { CoreBetterAuthRateLimiter } from '../src/core/modules/better-auth/core-better-auth-rate-limiter.service';
import { CoreBetterAuthUserMapper } from '../src/core/modules/better-auth/core-better-auth-user.mapper';
import { CoreSyncHintService, type SyncHintEvent } from '../src/core/modules/sync/core-sync-hints.service';
import { captureExpectedLogs } from './helpers/expected-log-output';

import type { ConfigService } from '../src/core/common/services/config.service';
import type { SchedulerRegistry } from '@nestjs/schedule';

/**
 * The ticket's acceptance criterion, exercised against a REAL Redis: run the framework's
 * shared-state features from TWO independent instances at once and assert the properties a
 * second replica is supposed to preserve — no job twice, no multiplied rate limit.
 *
 * Every other test in this area drives one instance against a fake. That proves the code
 * paths, not the property: a limiter that silently counted per process, or a lease key that
 * differed per instance, passes those and fails here. So each case below builds two fully
 * separate service instances — separate objects, separate in-memory state, one Redis —
 * which is exactly the shape of two pods.
 *
 * Requires a Redis on localhost:6380 (see .claude/rules/testing.md). 6379 is deliberately
 * avoided: on lt dev machines it is an auth-protected TurboOps Redis.
 */
const RUN_PREFIX = `nest-server-multi-replica-${Date.now()}-p${process.pid}`;

/**
 * @param scope optional extra key namespace, so one case can enumerate ITS OWN lease keys
 *   without seeing the ones another case in this file left behind. Still under `RUN_PREFIX`,
 *   so the `afterAll` sweep collects it.
 */
function createRedisService(scope?: string): CoreRedisService {
  const redisConfig = {
    db: 15,
    host: process.env.REDIS_HOST || 'localhost',
    keyPrefix: scope ? `${RUN_PREFIX}:${scope}` : RUN_PREFIX,
    options: { connectTimeout: 2000, maxRetriesPerRequest: 1 },
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6380,
  };
  return new CoreRedisService({
    getFastButReadOnly: (key: string, fallback?: unknown) => (key === 'redis' ? redisConfig : fallback),
  } as unknown as ConfigService);
}

/** Every key under `pattern`, sorted — used both by the assertions and by the teardown sweep */
async function scanKeys(client: any, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    found.push(...keys);
    cursor = next;
  } while (cursor !== '0');
  return found.sort();
}

/**
 * Poll until `check` holds, or FAIL with `message`.
 *
 * Deliberately a poll and not a fixed sleep. `runInitTick()` is fire-and-forget and
 * `runDistributedTick()` awaits a Redis round trip, so "wait one tick of the event loop and
 * assert" observes only whichever replica happened to be synchronous — see the comment on the
 * startup case below. A poll waits for the actual outcome, and a timeout is a real failure
 * rather than a quietly vacuous pass.
 */
async function waitUntil(check: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** A cron service standing in for one replica, recording every tick it actually ran */
class ReplicaCronJobs extends CoreCronJobs {
  calls: string[] = [];

  /**
   * Every lease this replica ASKED for, and whether it won.
   *
   * `calls` alone cannot distinguish "the other replica lost the race" from "the other replica
   * never got round to trying" — and the second is what a single-`setImmediate` wait actually
   * observes. Recording the decision makes the loser's attempt visible.
   */
  leaseDecisions: { key: string; won: boolean }[] = [];

  constructor(jobs: Record<string, any>, redisService: CoreRedisService) {
    super(
      { addCronJob: () => undefined, getCronJob: () => ({}) } as unknown as SchedulerRegistry,
      jobs,
      { log: false, redisService },
    );
  }

  /** Force the lease path: BullMQ is a separate mode with its own coverage */
  override importBullMq(): Promise<any> {
    return Promise.reject(new Error('Cannot find module'));
  }

  override runDistributedTick(name: string, fireTime: Date | 'init'): Promise<void> {
    return super.runDistributedTick(name, fireTime);
  }

  protected override async acquireLease(name: string, fireTime: Date | 'init' | 'manual'): Promise<boolean> {
    const won = await super.acquireLease(name, fireTime);
    this.leaseDecisions.push({ key: `${name}:${fireTime === 'init' || fireTime === 'manual' ? fireTime : fireTime.toISOString()}`, won });
    return won;
  }

  protected async report() {
    this.calls.push('report');
  }
}

/** A cron service in the real BullMQ mode (bullmq is a devDependency), with a short scheduler check */
class BullCronJobs extends CoreCronJobs {
  constructor(jobs: Record<string, any>, redisService: CoreRedisService, schedulerCheckIntervalMs: number) {
    super(
      { addCronJob: () => undefined, doesExist: () => false, getCronJob: () => ({}) } as unknown as SchedulerRegistry,
      jobs,
      { log: false, redisService },
    );
    this.bullSchedulerCheckIntervalMs = schedulerCheckIntervalMs;
  }

  get queue(): any {
    return this.bullQueue;
  }

  protected async report() {
    return undefined;
  }
}

/** A Better-Auth user mapper with its role cache switched on — the test environment switches it off */
class CachingUserMapper extends CoreBetterAuthUserMapper {
  constructor(users: { findOne: () => Promise<unknown> }, redisService: CoreRedisService) {
    super({ collection: () => users } as any, redisService);
    this.userCacheTtlMs = 15_000;
  }
}

/** cronTime that never fires on its own during the test run */
const NEVER = '0 0 1 1 *';

describe('Multi-replica behavior (real Redis)', () => {
  const services: CoreRedisService[] = [];

  beforeAll(async () => {
    const probe = createRedisService();
    await probe.onModuleInit();
    try {
      await probe.getClient().ping();
    } catch (error) {
      await probe.onApplicationShutdown();
      throw new Error(
        'This suite needs a Redis on localhost:6380. Start one with:\n'
        + '  docker run -d --name nest-server-2985-redis -p 6380:6379 redis:7.4-alpine\n'
        + `Original error: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error },
      );
    }
    services.push(probe);
  });

  afterAll(async () => {
    // Remove every key this run created, then close all connections
    const [probe] = services;
    if (probe?.enabled) {
      const client = probe.getClient();
      const keys = await scanKeys(client, `${RUN_PREFIX}:*`);
      if (keys.length) {
        await client.del(...keys);
      }
    }
    await Promise.all(services.map(service => service.onApplicationShutdown()));
  });

  it('runs a scheduled tick on exactly one replica', async () => {
    const [redisA, redisB] = [createRedisService(), createRedisService()];
    services.push(redisA, redisB);
    await Promise.all([redisA.onModuleInit(), redisB.onModuleInit()]);

    const replicaA = new ReplicaCronJobs({ report: { cronTime: NEVER, runOnInit: false } }, redisA);
    const replicaB = new ReplicaCronJobs({ report: { cronTime: NEVER, runOnInit: false } }, redisB);
    await Promise.all([replicaA.onApplicationBootstrap(), replicaB.onApplicationBootstrap()]);

    // Both replicas' timers fire for the SAME scheduled instant, as they would in production
    const fireTime = new Date('2026-08-08T12:00:00.000Z');
    await Promise.all([replicaA.runDistributedTick('report', fireTime), replicaB.runDistributedTick('report', fireTime)]);

    expect([...replicaA.calls, ...replicaB.calls]).toEqual(['report']);

    await Promise.all([replicaA.onApplicationShutdown(), replicaB.onApplicationShutdown()]);
  });

  /**
   * @regression   DEV-3896 — `runParallel: false` held only inside one process: a job that ran longer than its interval
   *   was started a second time on another replica. Against a real Redis, so the owner-checked renew and release
   *   (Lua) are exercised too.
   * @seen-failing Skip the running lease in runTick() in src/core/common/services/core-cron-jobs.service.ts — registered
   *   as mutation `cron-running-lease-e2e-missing` in tests/regression-mutations.json.
   */
  it('runs a runParallel: false job on one replica at a time, across ticks', async () => {
    const [redisA, redisB] = [createRedisService('running'), createRedisService('running')];
    services.push(redisA, redisB);
    await Promise.all([redisA.onModuleInit(), redisB.onModuleInit()]);

    let finish!: () => void;
    const gate = new Promise<void>(resolve => (finish = resolve));
    const jobs = { report: { cronTime: NEVER, runOnInit: false, runParallel: false } };
    const replicaA = new ReplicaCronJobs(jobs, redisA);
    const replicaB = new ReplicaCronJobs(jobs, redisB);
    (replicaA as any).report = async () => {
      replicaA.calls.push('report');
      await gate;
    };
    await Promise.all([replicaA.onApplicationBootstrap(), replicaB.onApplicationBootstrap()]);

    const running = replicaA.runDistributedTick('report', new Date('2026-08-08T13:00:00.000Z'));
    await waitUntil(() => replicaA.calls.length === 1, 'replica A to start the job');
    const runningKey = `${RUN_PREFIX}:running:cron-lock:report:running`;
    expect(await redisA.getClient().get(runningKey)).toBeTruthy();

    // The next tick, while A still runs: B wins the tick's lease and must still not start the job
    await replicaB.runDistributedTick('report', new Date('2026-08-08T13:01:00.000Z'));
    expect(replicaB.calls).toEqual([]);

    finish();
    await running;
    expect(await redisA.getClient().get(runningKey)).toBeNull();
    await replicaB.runDistributedTick('report', new Date('2026-08-08T13:02:00.000Z'));
    expect([...replicaA.calls, ...replicaB.calls]).toEqual(['report', 'report']);

    await Promise.all([replicaA.onApplicationShutdown(), replicaB.onApplicationShutdown()]);
  });

  it('renews and releases a Redis running lease only for its owner', async () => {
    const redis = createRedisService('owner');
    services.push(redis);
    await redis.onModuleInit();
    const replica = new ReplicaCronJobs({}, redis);
    const store = (replica as any).redisLeaseStore(redis.getClient());
    const key = `${RUN_PREFIX}:owner:cron-lock:job:running`;

    expect(await store.tryAcquire('job:running', 'owner-a', 60)).toBe(true);
    expect(await store.tryAcquire('job:running', 'owner-b', 60)).toBe(false);
    expect(await store.renew('job:running', 'owner-b', 600)).toBe(false);
    expect(await store.renew('job:running', 'owner-a', 600)).toBe(true);
    expect(await redis.getClient().ttl(key)).toBeGreaterThan(60);
    expect(await store.release('job:running', 'owner-b')).toBe(false);
    expect(await redis.getClient().get(key)).toBe('owner-a');
    expect(await store.release('job:running', 'owner-a')).toBe(true);
    expect(await redis.getClient().get(key)).toBeNull();
  });

  it('runs the startup tick on exactly one replica, even though they boot at different moments', async () => {
    // Own key scope, so the key enumeration at the end sees only THIS case's leases and not the
    // scheduled-tick lease the previous case left in Redis.
    const scope = 'init-tick';
    const leaseKeyPattern = `${RUN_PREFIX}:${scope}:cron-lock:*`;

    const [redisA, redisB] = [createRedisService(scope), createRedisService(scope)];
    services.push(redisA, redisB);
    await Promise.all([redisA.onModuleInit(), redisB.onModuleInit()]);

    // A rolling deploy: the second replica comes up a moment after the first
    const replicaA = new ReplicaCronJobs({ report: { cronTime: NEVER, runOnInit: true } }, redisA);
    await replicaA.onApplicationBootstrap();
    await new Promise(resolve => setTimeout(resolve, 1200));

    const replicaB = new ReplicaCronJobs({ report: { cronTime: NEVER, runOnInit: true } }, redisB);
    await replicaB.onApplicationBootstrap();

    // WAIT FOR THE OUTCOME, not for a fixed amount of time. `runOnInit` fires through
    // `runInitTick()`, which is deliberately fire-and-forget, and `runDistributedTick()` then
    // awaits `acquireLease()` — a Redis round trip. So B's tick cannot possibly have resolved by
    // the next `setImmediate`, which is exactly what this case used to wait for: it only ever
    // observed A, and a COMPLETELY BROKEN startup dedup would have passed it.
    await waitUntil(
      () => replicaA.leaseDecisions.length === 1 && replicaB.leaseDecisions.length === 1,
      'both replicas to settle their startup lease',
    );

    // Exactly one replica ran the job…
    expect([...replicaA.calls, ...replicaB.calls]).toEqual(['report']);

    // …and the other one ATTEMPTED and LOST. This is the half `calls` cannot show: without it,
    // "B never tried" and "B tried and was correctly refused" look identical.
    const decisions = [...replicaA.leaseDecisions, ...replicaB.leaseDecisions];
    expect(decisions.map(decision => decision.key)).toEqual(['report:init', 'report:init']);
    expect(decisions.filter(decision => decision.won)).toHaveLength(1);

    // ONE FIXED lease key for the whole fleet. Replicas do not share a boot instant, so a
    // clock-derived key would yield a distinct key per replica — and every replica would run the
    // job. Enumerating the keyspace pins both properties at once: the key is `report:init`, and
    // there is exactly one of them.
    expect(await scanKeys(redisA.getClient(), leaseKeyPattern)).toEqual([
      `${RUN_PREFIX}:${scope}:cron-lock:report:init`,
    ]);

    await Promise.all([replicaA.onApplicationShutdown(), replicaB.onApplicationShutdown()]);
  });

  /**
   * @regression   12.1.1 (DEV-3889) — the BullMQ schedulers were written into Redis once, at bootstrap. When Redis lost
   *   its data (a restart without persistence, a FLUSHDB, an eviction), nothing wrote them again and no replica ran a
   *   cron job until the next deploy.
   * @seen-failing Do not arm the timer in startBullSchedulerCheck() in
   *   src/core/common/services/core-cron-jobs.service.ts — registered as mutation `cron-e2e-scheduler-check-missing`
   *   in tests/regression-mutations.json.
   */
  it('registers the BullMQ schedulers again after their Redis data is gone', async () => {
    const scope = 'bull-restore';
    const redis = createRedisService(scope);
    services.push(redis);
    await redis.onModuleInit();

    const replica = new BullCronJobs({ report: { cronTime: NEVER, runOnInit: false } }, redis, 200);
    await replica.onApplicationBootstrap();
    try {
      expect(await replica.queue.getJobScheduler('report')).toBeTruthy();

      // Lose this application's queue data, the way a Redis restart without persistence does. Only its own keys:
      // other suites share this database, so a FLUSHDB would pull their data away mid-run.
      const client = redis.getClient();
      const keys = await scanKeys(client, `${RUN_PREFIX}:${scope}:bull:*`);
      expect(keys.length).toBeGreaterThan(0);
      await client.del(...keys);
      expect(await replica.queue.getJobScheduler('report')).toBeUndefined();

      // Back within one check interval (200 ms here); the deadline leaves room for a loaded machine.
      const deadline = Date.now() + 5000;
      let restored = await replica.queue.getJobScheduler('report');
      while (!restored && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        restored = await replica.queue.getJobScheduler('report');
      }
      expect(restored?.pattern).toBe(NEVER);
    } finally {
      await replica.onApplicationShutdown();
    }
  });

  /**
   * @regression   12.1.1 (DEV-3895) — invalidateUserCache() cleared only the replica it ran on: an admin whose role was
   *   withdrawn kept it on every other replica for up to 15 s, and without session affinity it was enough to keep
   *   sending requests.
   * @seen-failing Drop the publishInvalidation() call from invalidateUserCache() in
   *   src/core/modules/better-auth/core-better-auth-user.mapper.ts — registered as mutation
   *   `iam-user-cache-e2e-not-broadcast` in tests/regression-mutations.json.
   */
  it('withdraws a role on every replica at once, not only on the one that changed it', async () => {
    const scope = 'iam-user-cache';
    const [redisA, redisB] = [createRedisService(scope), createRedisService(scope)];
    services.push(redisA, redisB);
    await Promise.all([redisA.onModuleInit(), redisB.onModuleInit()]);

    // One user document both replicas read, as they read one database
    const stored = { _id: 'db-user-1', email: 'admin@test.com', iamId: 'iam-1', roles: ['admin'], verified: true };
    const users = { findOne: async () => ({ ...stored, roles: [...stored.roles] }) };
    const replicaA = new CachingUserMapper(users, redisA);
    const replicaB = new CachingUserMapper(users, redisB);
    await Promise.all([replicaA.onApplicationBootstrap(), replicaB.onApplicationBootstrap()]);
    const sessionUser = { email: stored.email, id: stored.iamId };
    try {
      expect((await replicaB.mapSessionUser(sessionUser))?.hasRole('admin')).toBe(true);

      // What CoreUserService.setRoles() does on replica A: write, then invalidate
      stored.roles = [];
      replicaA.invalidateUserCache(stored.iamId);

      // Redis delivers asynchronously; poll replica B rather than sleep. Before the broadcast existed, B answered from
      // its cache until the entry expired — 15 s, so the deadline here separates the two outcomes cleanly.
      const deadline = Date.now() + 5000;
      let mapped = await replicaB.mapSessionUser(sessionUser);
      while (mapped?.hasRole('admin') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        mapped = await replicaB.mapSessionUser(sessionUser);
      }
      expect(mapped?.roles).toEqual([]);
      expect(mapped?.hasRole('admin')).toBe(false);
    } finally {
      replicaA.onModuleDestroy();
      replicaB.onModuleDestroy();
    }
  });

  it('enforces ONE rate limit across replicas instead of one per replica', async () => {
    const [redisA, redisB] = [createRedisService(), createRedisService()];
    services.push(redisA, redisB);
    await Promise.all([redisA.onModuleInit(), redisB.onModuleInit()]);

    const max = 6;
    const limiterA = new CoreBetterAuthRateLimiter(redisA);
    const limiterB = new CoreBetterAuthRateLimiter(redisB);
    for (const limiter of [limiterA, limiterB]) {
      limiter.configure({ enabled: true, max, skipEndpoints: [], strictEndpoints: [], windowSeconds: 60 });
    }

    // Alternate between replicas, as a load balancer would
    const ip = '203.0.113.7';
    const verdicts: boolean[] = [];
    for (let i = 0; i < max + 2; i++) {
      const limiter = i % 2 === 0 ? limiterA : limiterB;
      verdicts.push((await limiter.check(ip, '/token')).allowed);
    }

    // Exactly `max` allowed in total. Per-replica counters would have allowed 2*max.
    expect(verdicts.filter(Boolean)).toHaveLength(max);
    expect(verdicts.slice(max)).toEqual([false, false]);

    // The block holds on BOTH replicas, not just the one that saw the limit break
    expect((await limiterA.check(ip, '/token')).allowed).toBe(false);
    expect((await limiterB.check(ip, '/token')).allowed).toBe(false);

    // A different client is unaffected
    expect((await limiterA.check('198.51.100.4', '/token')).allowed).toBe(true);
  });

  /**
   * @regression   DEV-3902 — a sync hint has to reach the subscribers of EVERY replica (a client's SSE stream or
   *   GraphQL socket ends on whichever replica the load balancer picked), and its own replica's exactly once.
   * @seen-failing Drop the Redis publish from CoreSyncHintService.send() in
   *   src/core/modules/sync/core-sync-hints.service.ts — registered as mutation `sync-hints-redis-not-published` in
   *   tests/regression-mutations.json.
   */
  it('delivers a sync hint to the subscribers of every replica, and to its own once', async () => {
    const [redisA, redisB] = [createRedisService('sync-hints'), createRedisService('sync-hints')];
    services.push(redisA, redisB);
    await Promise.all([redisA.onModuleInit(), redisB.onModuleInit()]);
    const replicaA = new CoreSyncHintService(redisA);
    const replicaB = new CoreSyncHintService(redisB);
    await Promise.all([replicaA.onApplicationBootstrap(), replicaB.onApplicationBootstrap()]);
    try {
      const atA: SyncHintEvent[] = [];
      const atB: SyncHintEvent[] = [];
      replicaA.subscribe((hint) => atA.push(hint));
      replicaB.subscribe((hint) => atB.push(hint));

      // A burst of writes in one tenant is one hint, on both replicas
      replicaA.notify('SyncNote', ['tenant-a']);
      replicaA.notify('SyncNote', ['tenant-a']);
      await waitUntil(() => atB.length >= 1, 'the hint on the other replica');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(atB).toEqual([expect.objectContaining({ model: 'SyncNote', tenantId: 'tenant-a' })]);
      // Delivered where it was sent at once, and not a second time when Redis brings it back
      expect(atA).toEqual([expect.objectContaining({ model: 'SyncNote', tenantId: 'tenant-a' })]);
    } finally {
      replicaA.onModuleDestroy();
      replicaB.onModuleDestroy();
    }
  });

  it('keeps serving rate-limit decisions when Redis goes away mid-flight', async () => {
    // The instance-kill half of the acceptance criterion: losing the shared store must cost
    // the bound's exactness, not the endpoint's availability.
    const redis = createRedisService();
    services.push(redis);
    await redis.onModuleInit();

    const limiter = new CoreBetterAuthRateLimiter(redis);
    limiter.configure({ enabled: true, max: 3, skipEndpoints: [], strictEndpoints: [], windowSeconds: 60 });

    expect((await limiter.check('203.0.113.9', '/token')).allowed).toBe(true);

    // Sever the connection the way a restarting Redis does
    const degradation = captureExpectedLogs();
    redis.getClient().disconnect();

    const afterOutage = await limiter.check('203.0.113.9', '/token');
    expect(afterOutage.allowed).toBe(true);
    expect(afterOutage.limit).toBe(3);
    // The degradation is REPORTED, once — documented behaviour, asserted rather than printed.
    expect(degradation.join('\n')).toContain('Falling back to per-replica in-memory limits');
  });
});
