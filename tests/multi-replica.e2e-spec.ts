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

function createRedisService(): CoreRedisService {
  const redisConfig = {
    db: 15,
    host: process.env.REDIS_HOST || 'localhost',
    keyPrefix: RUN_PREFIX,
    options: { connectTimeout: 2000, maxRetriesPerRequest: 1 },
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6380,
  };
  return new CoreRedisService({
    getFastButReadOnly: (key: string, fallback?: unknown) => (key === 'redis' ? redisConfig : fallback),
  } as unknown as ConfigService);
}

/** A cron service standing in for one replica, recording every tick it actually ran */
class ReplicaCronJobs extends CoreCronJobs {
  calls: string[] = [];

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
        + '  docker run -d --name nest-server-2985-redis -p 6380:6379 redis:7-alpine\n'
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
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${RUN_PREFIX}:*`, 'COUNT', 200);
        if (keys.length) {
          await client.del(...keys);
        }
        cursor = next;
      } while (cursor !== '0');
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
    const [redisA, redisB] = [createRedisService(), createRedisService()];
    services.push(redisA, redisB);
    await Promise.all([redisA.onModuleInit(), redisB.onModuleInit()]);

    // A rolling deploy: the second replica comes up a moment after the first
    const replicaA = new ReplicaCronJobs({ report: { cronTime: NEVER, runOnInit: true } }, redisA);
    await replicaA.onApplicationBootstrap();
    await new Promise(resolve => setTimeout(resolve, 1200));

    const replicaB = new ReplicaCronJobs({ report: { cronTime: NEVER, runOnInit: true } }, redisB);
    await replicaB.onApplicationBootstrap();
    await new Promise(resolve => setImmediate(resolve));

    expect([...replicaA.calls, ...replicaB.calls]).toEqual(['report']);

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
