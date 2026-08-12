import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreRedisService } from '../src/core/common/services/core-redis.service';
import { CoreCronJobs } from '../src/core/common/services/core-cron-jobs.service';
import { CoreBetterAuthRateLimiter } from '../src/core/modules/better-auth/core-better-auth-rate-limiter.service';

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
    redis.getClient().disconnect();

    const afterOutage = await limiter.check('203.0.113.9', '/token');
    expect(afterOutage.allowed).toBe(true);
    expect(afterOutage.limit).toBe(3);
  });
});
