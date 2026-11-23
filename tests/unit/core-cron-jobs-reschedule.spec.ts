import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCronJobsInfrastructure } from '../../src/core/common/services/core-cron-jobs.registry';
import { CoreCronJobs, CoreCronJobsOptions } from '../../src/core/common/services/core-cron-jobs.service';

/**
 * `CoreCronJobs.rescheduleCronJob()` (12.11.0): a public way to change a registered job's schedule at runtime, in both
 * modes the service runs a job in — a local cron timer (with a tick lease when distributed) and a BullMQ job
 * scheduler in Redis. Before it a project had to replace the job through protected internals, which skipped the
 * BullMQ scheduler, the removal marker and the restore after a data loss. The deduplication itself is pinned in
 * tests/unit/core-cron-jobs-dedup.spec.ts.
 */

/**
 * Minimal stand-in for the `cron-locks` collection, shared between the simulated replicas
 */
class FakeLockCollection {
  createIndex = vi.fn(async () => 'expiresAt_1');
  docs = new Map<string, Record<string, any>>();

  get ids(): Set<string> {
    return new Set(this.docs.keys());
  }

  /** The release of `MongoLockStore`: only by its owner */
  async deleteOne(filter: { _id: string; owner: string }) {
    const doc = this.docs.get(filter._id);
    if (doc?.owner !== filter.owner) {
      return { deletedCount: 0 };
    }
    this.docs.delete(filter._id);
    return { deletedCount: 1 };
  }

  /**
   * The claim of `MongoLockStore`: `{ _id, expiresAt: { $lte: now } }` with an upsert; its renewal:
   * `{ _id, expiresAt: { $gt: now }, owner }` without one
   */
  async updateOne(
    filter: { _id: string; expiresAt?: { $gt?: Date; $lte?: Date }; owner?: string },
    update: { $set: Record<string, any> },
    options?: { upsert?: boolean },
  ) {
    const doc = this.docs.get(filter._id);
    if (filter.owner !== undefined) {
      const held = doc && doc.owner === filter.owner && doc.expiresAt > filter.expiresAt!.$gt!;
      if (held) {
        this.docs.set(filter._id, { ...doc, ...update.$set });
      }
      return { matchedCount: held ? 1 : 0, upsertedCount: 0 };
    }
    if (doc && filter.expiresAt && doc.expiresAt <= filter.expiresAt.$lte) {
      this.docs.set(filter._id, { ...doc, ...update.$set });
      return { matchedCount: 1, upsertedCount: 0 };
    }
    if (doc) {
      if (options?.upsert) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      }
      return { matchedCount: 0, upsertedCount: 0 };
    }
    if (options?.upsert) {
      this.docs.set(filter._id, { ...update.$set });
      return { matchedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, upsertedCount: 0 };
  }
}

class TestCronJobs extends CoreCronJobs {
  bullMqModule: any;
  calls: string[] = [];

  constructor(jobs: Record<string, any>, options: CoreCronJobsOptions & { bullMq?: any } = {}) {
    super(new SchedulerRegistry(), jobs, options);
    this.bullMqModule = options.bullMq;
    this.bullSchedulerCheckIntervalMs = 0;
  }

  get registry(): SchedulerRegistry {
    return this.schedulerRegistry;
  }

  configOf(name: string) {
    return this.jobConfigs[name];
  }

  override importBullMq(): Promise<any> {
    return this.bullMqModule ? Promise.resolve(this.bullMqModule) : Promise.reject(new Error('Cannot find module'));
  }

  /** Stop every timer this service armed, so no case leaves one running */
  async close(): Promise<void> {
    for (const job of this.schedulerRegistry.getCronJobs().values()) {
      void job.stop();
    }
    await this.onApplicationShutdown();
  }

  protected async job1() {
    this.calls.push('job1');
  }
}

/** One Redis shared by every replica built from it: a queue whose schedulers live in a Map, keys in another */
function sharedBullMq() {
  const schedulers = new Map<string, { key: string; opts?: unknown; pattern: string; tz?: string }>();
  const keys = new Map<string, string>();
  const queueClient = new EventEmitter() as EventEmitter & { options: Record<string, unknown> };
  const upsert = vi.fn(async (name: string, repeat: { pattern: string; tz?: string }, template: { opts?: unknown }) => {
    schedulers.set(name, { key: name, opts: template?.opts, pattern: repeat.pattern, tz: repeat.tz });
  });
  const module = {
    Queue: class {
      close = vi.fn(async () => undefined);
      getJobCountByTypes = vi.fn(async () => 0);
      getJobSchedulers = vi.fn(async () => [...schedulers.values()]);
      removeJobScheduler = vi.fn(async (name: string) => schedulers.delete(name));
      upsertJobScheduler = upsert;
    },
    Worker: class {
      close = vi.fn(async () => undefined);
      concurrency = 1;
      on = vi.fn();
      run = vi.fn(async () => undefined);
    },
  };
  const client = {
    del: vi.fn(async (key: string) => (keys.delete(key) ? 1 : 0)),
    get: vi.fn(async (key: string) => keys.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      keys.set(key, value);
      return 'OK';
    }),
  };
  const redisService = {
    createClient: vi.fn((label?: string, connectionOptions?: Record<string, unknown>) => {
      if (label === 'cron-queue') {
        queueClient.options = { ...connectionOptions };
        return queueClient;
      }
      return { options: { ...connectionOptions } };
    }),
    enabled: true,
    getClient: () => client,
    getConfig: () => ({ keyPrefix: 'nest-server' }),
    key: (...parts: string[]) => ['nest-server', ...parts].join(':'),
  } as any;
  /** A Redis restart without persistence: schedulers and keys are gone */
  const restart = () => {
    schedulers.clear();
    keys.clear();
  };
  return { client, keys, module, queueClient, redisService, restart, schedulers, upsert };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function waitUntil(check: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('CoreCronJobs.rescheduleCronJob()', () => {
  const services: TestCronJobs[] = [];
  const create = (jobs: Record<string, any>, options?: CoreCronJobsOptions & { bullMq?: any }) => {
    const service = new TestCronJobs(jobs, options);
    services.push(service);
    return service;
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const service of services.splice(0)) {
      await service.close();
    }
    setCronJobsInfrastructure({});
    vi.restoreAllMocks();
  });

  describe('local timer', () => {
    it('replaces the timer with one on the new schedule, keeping the time zone and the config, without a startup run', async () => {
      const service = create({
        job1: { cronTime: '0 0 1 1 *', runOnInit: true, runParallel: false, throwException: false, timeZone: 'UTC' },
      });
      await service.onApplicationBootstrap();
      await flush();
      expect(service.calls).toEqual(['job1']);
      const before = service.registry.getCronJob('job1');

      await service.rescheduleCronJob('job1', '*/5 * * * *');

      const after = service.registry.getCronJob('job1');
      expect(after).not.toBe(before);
      expect(before.isActive).toBe(false);
      expect(after.isActive).toBe(true);
      expect(after.cronTime.source).toBe('*/5 * * * *');
      expect(after.cronTime.timeZone).toBe('UTC');
      expect(service.configOf('job1')).toMatchObject({
        cronTime: '*/5 * * * *',
        runOnInit: true,
        runParallel: false,
        throwException: false,
        timeZone: 'UTC',
      });
      await flush();
      // A reschedule is not a start
      expect(service.calls).toEqual(['job1']);
    });

    it('takes the tick lease of a distributed job on the instant of the NEW schedule', async () => {
      vi.useFakeTimers({ now: new Date('2026-08-07T10:00:20.000Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const collection = new FakeLockCollection();
      const service = create(
        { job1: { cronTime: '0 * * * * *', distributed: true, runOnInit: false, timeZone: 'UTC' } },
        { connection: { db: { collection: () => collection } } as any },
      );
      await service.onApplicationBootstrap();
      await service.rescheduleCronJob('job1', '30 * * * * *');

      // What cron does when its timer fires: record the moment, then call the job
      const job: any = service.registry.getCronJob('job1');
      vi.setSystemTime(new Date('2026-08-07T10:00:30.004Z'));
      job.lastExecution = new Date();
      await job.fireOnTick();
      for (let i = 0; i < 5; i++) {
        await flush();
      }

      expect(service.calls).toEqual(['job1']);
      expect([...collection.ids]).toEqual(['job1:2026-08-07T10:00:30.000Z']);
    });

    it('keeps a recurring job stopped that the Hub stopped on this replica', async () => {
      const service = create({ job1: { cronTime: '0 0 1 1 *', runOnInit: false } });
      await service.onApplicationBootstrap();
      void service.registry.getCronJob('job1').stop();

      await service.rescheduleCronJob('job1', '0 0 2 1 *');

      expect(service.registry.getCronJob('job1').cronTime.source).toBe('0 0 2 1 *');
      expect(service.registry.getCronJob('job1').isActive).toBe(false);
    });

    it('takes a future date, and { cronTime, utcOffset } in place of the time zone', async () => {
      const service = create({ job1: { cronTime: '0 0 1 1 *', runOnInit: false } });
      await service.onApplicationBootstrap();
      const at = new Date(Date.now() + 3_600_000);

      await service.rescheduleCronJob('job1', at);
      expect(service.registry.getCronJob('job1').nextDate().toMillis()).toBe(at.getTime());

      await service.rescheduleCronJob('job1', { cronTime: '0 12 * * *', utcOffset: 120 });
      expect(service.configOf('job1')).toMatchObject({ cronTime: '0 12 * * *', timeZone: null, utcOffset: 120 });
      expect(service.registry.getCronJob('job1').cronTime.utcOffset).toBe(120);
    });

    /**
     * The paired refusal: a schedule that cannot fire must not cost the job the schedule it had — validated before the
     * old timer is touched.
     */
    it('rejects an invalid expression, an unknown time zone or a past date and leaves the job as it was', async () => {
      const service = create({ job1: { cronTime: '0 0 1 1 *', runOnInit: false } });
      await service.onApplicationBootstrap();
      const before = service.registry.getCronJob('job1');

      for (const schedule of [
        'not a cron',
        { cronTime: '* * * * *', timeZone: 'Not/AZone' },
        new Date(Date.now() - 1000),
        { cronTime: undefined as any },
      ]) {
        await expect(service.rescheduleCronJob('job1', schedule as any)).rejects.toThrow();
      }

      expect(service.registry.getCronJob('job1')).toBe(before);
      expect(before.isActive).toBe(true);
      expect(service.configOf('job1').cronTime).toBe('0 0 1 1 *');
      // A rejected call does not block the next one
      await service.rescheduleCronJob('job1', '0 0 3 1 *');
      expect(service.registry.getCronJob('job1').cronTime.source).toBe('0 0 3 1 *');
    });

    it('rejects a job that is not registered: unknown, disabled, before bootstrap, after shutdown', async () => {
      const service = create({ disabled: { cronTime: '* * * * *', disabled: true }, job1: '0 0 1 1 *' });
      await expect(service.rescheduleCronJob('job1', '* * * * *')).rejects.toThrow('CronJob job1 is not registered');
      await service.onApplicationBootstrap();
      await expect(service.rescheduleCronJob('unknown', '* * * * *')).rejects.toThrow('not registered');
      await expect(service.rescheduleCronJob('disabled', '* * * * *')).rejects.toThrow('not registered');

      await service.onApplicationShutdown();
      await expect(service.rescheduleCronJob('job1', '* * * * *')).rejects.toThrow('not registered');
    });
  });

  describe('BullMQ job scheduler', () => {
    it('writes the new pattern into Redis with the same job options and replaces the Hub entry', async () => {
      const bull = sharedBullMq();
      const service = create(
        { job1: { cronTime: '*/5 * * * *', runOnInit: true, timeZone: 'Europe/Berlin' } },
        { bullMq: bull.module, redisService: bull.redisService },
      );
      await service.onApplicationBootstrap();
      await flush();
      expect(service.calls).toEqual(['job1']);

      await service.rescheduleCronJob('job1', { cronTime: '0 6 * * *', timeZone: 'UTC' });

      expect(bull.upsert).toHaveBeenLastCalledWith(
        'job1',
        { pattern: '0 6 * * *', tz: 'UTC' },
        { name: 'job1', opts: { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } } },
      );
      const entry = service.registry.getCronJob('job1');
      expect(entry.isActive).toBe(false);
      expect(entry.cronTime.source).toBe('0 6 * * *');
      await flush();
      expect(service.calls).toEqual(['job1']);
    });

    it('brings the NEW schedule back after a data loss', async () => {
      const bull = sharedBullMq();
      const service = create(
        { job1: { cronTime: '*/5 * * * *', runOnInit: false } },
        { bullMq: bull.module, redisService: bull.redisService },
      );
      await service.onApplicationBootstrap();
      await service.rescheduleCronJob('job1', '0 6 * * *');

      bull.restart();
      bull.queueClient.emit('ready');
      await waitUntil(() => bull.schedulers.has('job1'), 'the restore to register the scheduler again');

      expect(bull.schedulers.get('job1')?.pattern).toBe('0 6 * * *');
    });

    /**
     * An upsert is not free in BullMQ: it drops the tick the scheduler planned last and plans from now. Called on every
     * replica — as it must be — an unchanged schedule must therefore be written once, not once per replica.
     */
    it('writes an unchanged schedule only once when every replica reschedules', async () => {
      const bull = sharedBullMq();
      const jobs = { job1: { cronTime: '*/5 * * * *', runOnInit: false } };
      const replicaA = create(jobs, { bullMq: bull.module, redisService: bull.redisService });
      const replicaB = create(jobs, { bullMq: bull.module, redisService: bull.redisService });
      await replicaA.onApplicationBootstrap();
      await replicaB.onApplicationBootstrap();
      const upserts = bull.upsert.mock.calls.length;

      await replicaA.rescheduleCronJob('job1', '0 6 * * *');
      await replicaB.rescheduleCronJob('job1', '0 6 * * *');

      expect(bull.upsert.mock.calls.length).toBe(upserts + 1);
      expect(replicaB.configOf('job1').cronTime).toBe('0 6 * * *');
    });

    it('moves a job BullMQ cannot express to a local timer with lease, and back to BullMQ with a cron expression', async () => {
      const bull = sharedBullMq();
      const jobs = { job1: { cronTime: '*/5 * * * *', runOnInit: false } };
      const moved = create(jobs, { bullMq: bull.module, redisService: bull.redisService });
      const unchanged = create(jobs, { bullMq: bull.module, redisService: bull.redisService });
      await moved.onApplicationBootstrap();
      await unchanged.onApplicationBootstrap();

      await moved.rescheduleCronJob('job1', new Date(Date.now() + 3_600_000));

      expect(bull.schedulers.has('job1')).toBe(false);
      expect(bull.keys.has('nest-server:cron-scheduler-removed:job1')).toBe(true);
      expect(moved.registry.getCronJob('job1').isActive).toBe(true);
      expect(moved.configOf('job1').cronTime).toBeInstanceOf(Date);
      // The replica that still schedules the job through BullMQ does not bring the scheduler back
      bull.queueClient.emit('ready');
      await flush();
      await flush();
      expect(bull.schedulers.has('job1')).toBe(false);

      await moved.rescheduleCronJob('job1', '0 6 * * *');
      expect(bull.schedulers.get('job1')?.pattern).toBe('0 6 * * *');
      expect(bull.keys.has('nest-server:cron-scheduler-removed:job1')).toBe(false);
      expect(moved.registry.getCronJob('job1').isActive).toBe(false);
    });

    it('keeps the old schedule when Redis refuses the new one', async () => {
      const bull = sharedBullMq();
      const service = create(
        { job1: { cronTime: '*/5 * * * *', runOnInit: false } },
        { bullMq: bull.module, redisService: bull.redisService },
      );
      await service.onApplicationBootstrap();
      bull.upsert.mockRejectedValueOnce(new Error('Connection is closed'));

      await expect(service.rescheduleCronJob('job1', '0 6 * * *')).rejects.toThrow('Connection is closed');

      expect(service.configOf('job1').cronTime).toBe('*/5 * * * *');
      expect(service.registry.getCronJob('job1').cronTime.source).toBe('*/5 * * * *');
      bull.restart();
      bull.queueClient.emit('ready');
      await waitUntil(() => bull.schedulers.has('job1'), 'the restore to register the scheduler again');
      expect(bull.schedulers.get('job1')?.pattern).toBe('*/5 * * * *');
    });

    it('reschedules a job that is not distributed on its local timer, leaving BullMQ alone', async () => {
      const bull = sharedBullMq();
      const service = create(
        { job1: { cronTime: '*/5 * * * *', distributed: false, runOnInit: false } },
        { bullMq: bull.module, redisService: bull.redisService },
      );
      await service.onApplicationBootstrap();
      const upserts = bull.upsert.mock.calls.length;

      await service.rescheduleCronJob('job1', '0 6 * * *');

      expect(bull.upsert.mock.calls.length).toBe(upserts);
      expect(bull.schedulers.has('job1')).toBe(false);
      expect(service.registry.getCronJob('job1').isActive).toBe(true);
      expect(service.registry.getCronJob('job1').cronTime.source).toBe('0 6 * * *');
    });
  });
});
