import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCronJobsInfrastructure } from '../../src/core/common/services/core-cron-jobs.registry';
import { CoreCronJobs, CoreCronJobsOptions } from '../../src/core/common/services/core-cron-jobs.service';

/**
 * Minimal stand-in for the `cron-locks` collection, shared between the simulated replicas
 */
class FakeLockCollection {
  createIndex = vi.fn(async () => 'createdAt_1');
  ids = new Set<string>();

  async insertOne(doc: { _id: string }) {
    if (this.ids.has(doc._id)) {
      throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    }
    this.ids.add(doc._id);
    return { insertedId: doc._id };
  }
}

class TestCronJobs extends CoreCronJobs {
  bullMqModule: any;
  calls: string[] = [];

  constructor(jobs: Record<string, any>, options: CoreCronJobsOptions & { bullMq?: any }) {
    super(
      // `doesExist` + `addCronJob`: BullMQ-mode jobs are registered as STOPPED CronJobs so the
      // Hub's cron panel — which reads only SchedulerRegistry — can see and control them.
      {
        addCronJob: vi.fn(),
        doesExist: vi.fn(() => false),
        getCronJob: vi.fn(() => ({})),
      } as unknown as SchedulerRegistry,
      jobs,
      options,
    );
    this.bullMqModule = options.bullMq;
  }

  override importBullMq(): Promise<any> {
    return this.bullMqModule ? Promise.resolve(this.bullMqModule) : Promise.reject(new Error('Cannot find module'));
  }

  override runDistributedTick(name: string, fireTime: Date | 'init' | 'manual'): Promise<void> {
    return super.runDistributedTick(name, fireTime);
  }

  protected async job1() {
    this.calls.push('job1');
  }
}

/** cronTime that never fires during the test run */
const NEVER = '0 0 1 1 *';

function fakeConnection(collection: FakeLockCollection) {
  return { db: { collection: () => collection } } as any;
}

function fakeRedisService(overrides: Record<string, any> = {}) {
  return {
    // Models the real contract: per-connection overrides land in `options`, which is how the
    // BullMQ connections opt out of the shared commandTimeout.
    createClient: vi.fn((_label?: string, connectionOptions?: Record<string, unknown>) => ({
      options: { commandTimeout: 2000, ...connectionOptions },
    })),
    enabled: true,
    getClient: vi.fn(),
    getConfig: () => ({ keyPrefix: 'nest-server' }),
    key: (...parts: string[]) => ['nest-server', ...parts].join(':'),
    ...overrides,
  } as any;
}

/** Let the async onTick triggered by runOnInit settle */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('CoreCronJobs multi-replica deduplication', () => {
  let collection: FakeLockCollection;

  beforeEach(() => {
    collection = new FakeLockCollection();
    // CoreCronJobs logs through Nest's Logger (one module-level instance), so the prototype is where to listen.
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setCronJobsInfrastructure({});
    vi.restoreAllMocks();
  });

  describe('registry', () => {
    it('activates dedup without any constructor change', async () => {
      setCronJobsInfrastructure({ connection: fakeConnection(collection) });
      const service = new TestCronJobs({ job1: { cronTime: NEVER, runOnInit: false } }, {});
      await service.onApplicationBootstrap();

      const fireTime = new Date('2026-08-07T10:00:00.000Z');
      await service.runDistributedTick('job1', fireTime);
      await service.runDistributedTick('job1', fireTime);

      expect(service.calls).toEqual(['job1']);
      expect([...collection.ids]).toEqual(['job1:2026-08-07T10:00:00.000Z']);
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it('is overridden by the options object', async () => {
      const registryCollection = new FakeLockCollection();
      setCronJobsInfrastructure({ connection: fakeConnection(registryCollection) });
      const service = new TestCronJobs(
        { job1: { cronTime: NEVER, distributed: true, runOnInit: false } },
        { connection: fakeConnection(collection) },
      );
      await service.onApplicationBootstrap();

      await service.runDistributedTick('job1', new Date('2026-08-07T10:00:00.000Z'));

      expect(collection.ids.size).toBe(1);
      expect(registryCollection.ids.size).toBe(0);
    });
  });

  describe('MongoDB lease mode', () => {
    it('does not lease at all without a redis config', async () => {
      // The ticket's hard constraint: with no `redis` config the service behaves exactly as
      // before. A single-replica project that upgrades must not silently acquire a
      // cron-locks collection, a lease write per tick, and a new way for a tick to be
      // skipped. The Mongo lease stays reachable for a Redis-less multi-replica fleet, but
      // only through an explicit `distributed: true`.
      const service = new TestCronJobs(
        { job1: { cronTime: NEVER, runOnInit: true } },
        { connection: fakeConnection(collection) },
      );

      await service.onApplicationBootstrap();
      await flush();

      expect(service.calls).toEqual(['job1']);
      expect(collection.ids.size).toBe(0);
      expect(collection.createIndex).not.toHaveBeenCalled();
    });

    it('leases when a job opts in explicitly despite no redis', async () => {
      const service = new TestCronJobs(
        { job1: { cronTime: NEVER, distributed: true, runOnInit: true } },
        { connection: fakeConnection(collection) },
      );

      await service.onApplicationBootstrap();
      await flush();

      expect(service.calls).toEqual(['job1']);
      expect([...collection.ids]).toEqual(['job1:init']);
    });

    it('never leases a job with distributed: false', async () => {
      const service = new TestCronJobs(
        { job1: { cronTime: NEVER, distributed: false, runOnInit: true } },
        { connection: fakeConnection(collection) },
      );

      await service.onApplicationBootstrap();
      await flush();

      expect(service.calls).toEqual(['job1']);
      expect(collection.ids.size).toBe(0);
      expect(collection.createIndex).not.toHaveBeenCalled();
    });

    it('runs the callback only once when two replicas fire the same tick', async () => {
      const fireTime = new Date('2026-08-07T10:00:00.000Z');
      const replicaA = new TestCronJobs(
        { job1: { cronTime: NEVER, distributed: true, runOnInit: false } },
        { connection: fakeConnection(collection) },
      );
      const replicaB = new TestCronJobs(
        { job1: { cronTime: NEVER, distributed: true, runOnInit: false } },
        { connection: fakeConnection(collection) },
      );
      await replicaA.onApplicationBootstrap();
      await replicaB.onApplicationBootstrap();

      await replicaA.runDistributedTick('job1', fireTime);
      await replicaB.runDistributedTick('job1', fireTime);

      expect([...replicaA.calls, ...replicaB.calls]).toEqual(['job1']);
      expect([...collection.ids]).toEqual(['job1:2026-08-07T10:00:00.000Z']);
    });

    it('runs the startup tick once across replicas that boot at different moments', async () => {
      // `runOnInit` DEFAULTS to true, so this is the common path, and it is the one a
      // clock-derived lease key cannot deduplicate: replicas never boot at the same
      // instant, so each would compute a different key and every one would run the job.
      // The startup lease therefore uses one fixed key per job.
      const replicaA = new TestCronJobs(
        { job1: { cronTime: NEVER, distributed: true, runOnInit: true } },
        { connection: fakeConnection(collection) },
      );
      await replicaA.onApplicationBootstrap();
      await flush();

      // Second replica boots measurably later, as a rolling deploy does
      await new Promise(resolve => setTimeout(resolve, 1100));

      const replicaB = new TestCronJobs(
        { job1: { cronTime: NEVER, distributed: true, runOnInit: true } },
        { connection: fakeConnection(collection) },
      );
      await replicaB.onApplicationBootstrap();
      await flush();

      expect([...replicaA.calls, ...replicaB.calls]).toEqual(['job1']);
      expect([...collection.ids]).toEqual(['job1:init']);
    });

    it('does not let a throwing startup run escape as an unhandled rejection', async () => {
      // The startup tick is deliberately not awaited, so nothing up the stack can catch it —
      // and `runTick` re-throws whenever `throwException` is set, which is the default.
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);

      const service = new TestCronJobs(
        { boom: { cronTime: NEVER, distributed: true, runOnInit: true, throwException: true } },
        { connection: fakeConnection(collection) },
      );
      (service as any).boom = async () => {
        throw new Error('startup boom');
      };

      await service.onApplicationBootstrap();
      await flush();
      await new Promise(resolve => setImmediate(resolve));

      process.off('unhandledRejection', onRejection);
      expect(rejections).toEqual([]);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('CronJob boom failed on its startup run'),
        expect.any(String),
      );
    });

    it('logs the skipped tick on a duplicate key and creates the TTL index once', async () => {
      const service = new TestCronJobs(
        { job1: { cronTime: NEVER, distributed: true, runOnInit: false } },
        { connection: fakeConnection(collection) },
      );
      await service.onApplicationBootstrap();

      const fireTime = new Date('2026-08-07T10:00:00.500Z');
      await service.runDistributedTick('job1', fireTime);
      await service.runDistributedTick('job1', fireTime);

      expect(service.calls).toEqual(['job1']);
      expect(collection.createIndex).toHaveBeenCalledTimes(1);
      // expireAfterSeconds: 0 = "expire at the date in this field", so each lease can carry
      // its own lifetime — a scheduled tick's hour and a startup lease's short window share
      // one collection, which a fixed expireAfterSeconds could not express.
      expect(collection.createIndex).toHaveBeenCalledWith({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      expect(Logger.prototype.debug).toHaveBeenCalledWith(
        'CronJob tick job1:2026-08-07T10:00:00.000Z skipped, lease held by another replica',
      );
    });

    it('warns once and runs the tick when neither Redis nor a connection is available', async () => {
      const service = new TestCronJobs({ job1: { cronTime: NEVER, runOnInit: false } }, {});
      await service.onApplicationBootstrap();

      await service.runDistributedTick('job1', new Date());
      await service.runDistributedTick('job1', new Date());

      expect(service.calls).toEqual(['job1', 'job1']);
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('Cron job deduplication is inactive'));
    });
  });

  describe('Redis lease mode', () => {
    it('skips the tick when SET NX loses the race', async () => {
      const set = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
      const service = new TestCronJobs(
        { job1: { cronTime: NEVER, runOnInit: false } },
        { redisService: fakeRedisService({ getClient: () => ({ set }) }) },
      );
      await service.onApplicationBootstrap();

      const fireTime = new Date('2026-08-07T10:00:00.000Z');
      await service.runDistributedTick('job1', fireTime);
      await service.runDistributedTick('job1', fireTime);

      expect(service.calls).toEqual(['job1']);
      expect(set).toHaveBeenCalledWith('nest-server:cron-lock:job1:2026-08-07T10:00:00.000Z', '1', 'EX', 3600, 'NX');
    });
  });

  describe('BullMQ mode', () => {
    let upsertJobScheduler: ReturnType<typeof vi.fn>;
    let processor: (job: { name: string }) => Promise<void>;
    let queueArgs: any[];
    let workerArgs: any[];
    let bullMq: any;

    beforeEach(() => {
      upsertJobScheduler = vi.fn(async () => undefined);
      queueArgs = [];
      workerArgs = [];
      bullMq = {
        Queue: class {
          close = vi.fn(async () => undefined);
          upsertJobScheduler = upsertJobScheduler;
          constructor(...args: any[]) {
            queueArgs = args;
          }
        },
        Worker: class {
          close = vi.fn(async () => undefined);
          concurrency = 1;
          // The service attaches an 'error' listener, so the fake needs the EventEmitter surface
          on = vi.fn();
          // Created with autorun: false and started only after every job config is
          // registered, so the fake has to offer run() the way BullMQ does.
          run = vi.fn(async () => undefined);
          constructor(...args: any[]) {
            workerArgs = args;
            processor = args[1];
          }
        },
      };
    });

    it('registers a job scheduler and dispatches the worker job to the callback', async () => {
      const redisService = fakeRedisService({ getClient: () => ({ set: vi.fn().mockResolvedValue('OK') }) });
      const service = new TestCronJobs(
        { job1: { cronTime: '*/5 * * * *', runOnInit: false, timeZone: 'Europe/Berlin' } },
        { bullMq, redisService },
      );

      await service.onApplicationBootstrap();

      expect(upsertJobScheduler).toHaveBeenCalledWith(
        'job1',
        { pattern: '*/5 * * * *', tz: 'Europe/Berlin' },
        { name: 'job1' },
      );
      expect(queueArgs[0]).toBe('cron');
      expect(queueArgs[1].prefix).toBe('nest-server:bull');
      expect(workerArgs[2].connection.options.maxRetriesPerRequest).toBeNull();

      await processor({ name: 'job1' });
      expect(service.calls).toEqual(['job1']);
    });

    it('runs runOnInit once under a lease, since BullMQ schedulers do not fire immediately', async () => {
      const set = vi.fn().mockResolvedValue('OK');
      const service = new TestCronJobs(
        { job1: { cronTime: '*/5 * * * *', runOnInit: true } },
        { bullMq, redisService: fakeRedisService({ getClient: () => ({ set }) }) },
      );

      await service.onApplicationBootstrap();
      await flush();

      expect(service.calls).toEqual(['job1']);
      expect(set).toHaveBeenCalledTimes(1);
    });

    it('falls back to the lease path for a Date cronTime', async () => {
      const service = new TestCronJobs(
        { job1: { cronTime: new Date(Date.now() + 3600000), runOnInit: false } },
        {
          bullMq,
          connection: fakeConnection(collection),
          redisService: fakeRedisService({ getClient: () => undefined }),
        },
      );

      await service.onApplicationBootstrap();

      expect(upsertJobScheduler).not.toHaveBeenCalled();
      expect(Logger.prototype.debug).toHaveBeenCalledWith(expect.stringContaining('cronTime is a Date'));
    });

    it('closes worker and queue on application shutdown', async () => {
      const service = new TestCronJobs(
        { job1: { cronTime: '*/5 * * * *', runOnInit: false } },
        { bullMq, redisService: fakeRedisService() },
      );
      await service.onApplicationBootstrap();

      await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
    });

    it('warns once about the missing bullmq peer and falls back to the lease path', async () => {
      const service = new TestCronJobs(
        { job1: { cronTime: '*/5 * * * *', runOnInit: false } },
        { connection: fakeConnection(collection), redisService: fakeRedisService({ getClient: () => undefined }) },
      );

      await service.onApplicationBootstrap();
      await service.runDistributedTick('job1', new Date('2026-08-07T10:00:00.000Z'));

      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
      // The warning names the load error, so a bullmq that is installed but fails to load is not misreported as missing.
      expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('"bullmq" could not be loaded (Cannot find module)'));
      expect([...collection.ids]).toEqual(['job1:2026-08-07T10:00:00.000Z']);
      expect(service.calls).toEqual(['job1']);
    });
  });
});
