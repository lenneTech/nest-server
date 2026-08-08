import { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { CronJobConfigWithTimeZone } from '../interfaces/cron-job-config-with-time-zone.interface';
import { CronJobConfigWithUtcOffset } from '../interfaces/cron-job-config-with-utc-offset.interface';
import { Falsy } from '../types/falsy.type';
import { getCronJobsInfrastructure } from './core-cron-jobs.registry';

import type { CoreRedisService } from './core-redis.service';
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';

/**
 * Collection holding the per-tick cron leases.
 *
 * It has no Mongoose schema, so the native driver is the correct access path here
 * (see docs/native-driver-security.md).
 */
const CRON_LOCK_COLLECTION = 'cron-locks';

/**
 * Lifetime of a cron lease: long enough to outlive any tick, short enough to keep
 * the lock collection / keyspace small.
 */
const CRON_LOCK_TTL_SECONDS = 3600;

/**
 * Name of the shared BullMQ queue carrying all distributed cron jobs
 */
const CRON_QUEUE_NAME = 'cron';

/**
 * Optional dependencies of CoreCronJobs
 *
 * CoreCronJobs is abstract and instantiated by the consuming project, so its
 * dependencies cannot be injected by the framework. A subclass MAY pass them here
 * (see .claude/rules/core-modules.md → "Optional Constructor Parameters"); existing
 * `super(schedulerRegistry, cronJobs, { log })` calls keep compiling unchanged.
 *
 * Passing them is optional: what is not given here is looked up in
 * `core-cron-jobs.registry.ts`, which CoreModule populates — so deduplication works
 * without any change to an existing subclass. Values passed here take precedence.
 *
 * With neither source the service behaves exactly as before — every replica runs
 * every tick — and warns once.
 */
export interface CoreCronJobsOptions {
  /** Mongoose connection used for the per-tick MongoDB lease (fallback mode) */
  connection?: Connection;

  /** Whether cron job initialization is logged */
  log?: boolean;

  /** Central Redis service; enables the BullMQ job-scheduler mode */
  redisService?: CoreRedisService;
}

/**
 * Cron jobs service to extend
 *
 * Jobs are deduplicated across replicas unless `distributed: false` is set:
 * - Redis configured + `bullmq` installed: the job becomes a BullMQ job scheduler,
 *   so exactly one worker in the cluster picks up each tick.
 * - Otherwise: the local cron timer stays, but each tick first acquires a lease
 *   (Redis `SET NX` when available, else a `cron-locks` document in MongoDB).
 */
export abstract class CoreCronJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  /**
   * Config for cron jobs
   */
  config: {
    [key: string]: any;
    log: boolean;
  };

  /**
   * Cron jobs that are currently running
   */
  runningJobs: Record<string, Date[]> = {};

  /** Shared BullMQ queue, created only in BullMQ mode */
  protected bullQueue?: any;

  /** Shared BullMQ worker, created only in BullMQ mode */
  protected bullWorker?: any;

  /** Whether the "deduplication inactive" warning was already emitted */
  protected dedupWarned = false;

  /** Normalized config per job name, used by the tick wrapper of both modes */
  protected jobConfigs: Record<string, CronJobConfigWithTimeZone> = {};

  /** Cached creation of the TTL index on the lock collection */
  protected leaseIndexReady?: Promise<void>;

  // ===================================================================================================================
  // Initializations
  // ===================================================================================================================

  /**
   * Integrate services and init chron jobs
   */
  protected constructor(
    protected schedulerRegistry: SchedulerRegistry,
    protected cronJobs: Record<
      string,
      CronExpression | CronJobConfigWithTimeZone | CronJobConfigWithUtcOffset | Date | Falsy | string
    >,
    protected readonly options?: CoreCronJobsOptions,
  ) {
    this.config = {
      log: true,
      ...options,
    };
  }

  /**
   * Lifecycle hook method: Called once all modules have been initialized, but before listening for connections.
   * Required to ensure that all services have been previously initiated
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.log) {
      console.info('Init CronJobs after application bootstrap');
    }
    await this.initCronJobs();
  }

  /**
   * Close the BullMQ worker and queue
   */
  async onApplicationShutdown(): Promise<void> {
    await this.bullWorker?.close();
    await this.bullQueue?.close();
    this.bullWorker = undefined;
    this.bullQueue = undefined;
  }

  /**
   * Init cron jobs
   */
  protected async initCronJobs(): Promise<void> {
    // Get cron jobs
    if (!this.cronJobs) {
      return;
    }

    const bullMqActive = await this.initBullMq();

    // Init cron jobs
    for (const [name, CronExpressionOrConfig] of Object.entries(this.cronJobs)) {
      // Check config
      if (
        !CronExpressionOrConfig ||
        (typeof CronExpressionOrConfig === 'object' && (CronExpressionOrConfig as CronJobConfigWithTimeZone).disabled)
      ) {
        continue;
      }

      // Prepare config
      let conf: CronJobConfigWithTimeZone | CronJobConfigWithUtcOffset = CronExpressionOrConfig as
        | CronJobConfigWithTimeZone
        | CronJobConfigWithUtcOffset;
      if (typeof CronExpressionOrConfig === 'string' || CronExpressionOrConfig instanceof Date) {
        conf = {
          cronTime: CronExpressionOrConfig as Date | string,
        };
      }

      // Set defaults
      // Declared as CronJobConfigWithTimeZone to avoid type errors, but it can also be CronJobConfigWithUtcOffset
      const config: CronJobConfigWithTimeZone = {
        distributed: true,
        runOnInit: true,
        runParallel: true,
        throwException: true,
        timeZone: conf.utcOffset ? null : 'Europe/Berlin',
        ...conf,
      } as unknown as CronJobConfigWithTimeZone;

      // Check if cron job should be activated
      if (!config?.cronTime) {
        continue;
      }

      // check if cron job exists
      if (!this[name]) {
        if (this.config.log) {
          console.info(`Missing cron job function ${name}`);
        }
        continue;
      }

      this.jobConfigs[name] = config;
      const distributed = config.distributed !== false;

      // Init cron job as BullMQ job scheduler, when possible
      if (bullMqActive && distributed) {
        if (typeof config.cronTime === 'string' && !config.utcOffset) {
          await this.registerBullJob(name, config);
          continue;
        }
        console.debug(
          `CronJob ${name} cannot be expressed as BullMQ scheduler (${
            typeof config.cronTime === 'string' ? 'utcOffset is set' : 'cronTime is a Date'
          }), falling back to a local timer with lease`,
        );
      }

      // Init local cron job
      this.registerLocalJob(name, config, distributed);
    }
  }

  /**
   * Acquire the lease for a single tick.
   *
   * Returns `true` when this replica may run the tick — including when no lease
   * backend is available at all (fail open: a missing lock must never stop the job).
   */
  protected async acquireLease(name: string, fireTime: Date): Promise<boolean> {
    const leaseKey = `${name}:${new Date(Math.floor(fireTime.getTime() / 1000) * 1000).toISOString()}`;

    const redis = this.getRedisClient();
    if (redis) {
      const acquired = await redis.set(
        this.getRedisService().key('cron-lock', leaseKey),
        '1',
        'EX',
        CRON_LOCK_TTL_SECONDS,
        'NX',
      );
      if (acquired === null) {
        this.logSkippedTick(leaseKey);
        return false;
      }
      return true;
    }

    const connection = this.getConnection();
    if (!connection) {
      this.warnDedupInactive();
      return true;
    }

    await this.ensureLeaseIndex(connection);
    try {
      await connection.db.collection(CRON_LOCK_COLLECTION).insertOne({ _id: leaseKey as any, createdAt: new Date() });
      return true;
    } catch (e: any) {
      if (e?.code === 11000) {
        this.logSkippedTick(leaseKey);
        return false;
      }
      console.error(`Cron lease for ${leaseKey} failed, running the tick anyway`, e);
      return true;
    }
  }

  /**
   * Create the TTL index on the lock collection once
   */
  protected async ensureLeaseIndex(connection: Connection): Promise<void> {
    if (!this.leaseIndexReady) {
      this.leaseIndexReady = connection.db
        .collection(CRON_LOCK_COLLECTION)
        .createIndex({ createdAt: 1 }, { expireAfterSeconds: CRON_LOCK_TTL_SECONDS })
        .then(() => undefined)
        .catch((e) => {
          console.error('Could not create TTL index on cron lock collection', e);
        });
    }
    return this.leaseIndexReady;
  }

  /**
   * Mongoose connection from the options object, else from the registry.
   * Resolved on every access so a late registration still takes effect.
   */
  protected getConnection(): Connection | undefined {
    return this.options?.connection ?? getCronJobsInfrastructure().connection;
  }

  /**
   * Shared Redis client, or undefined when Redis is not available
   */
  protected getRedisClient(): Redis | undefined {
    const service = this.getRedisService();
    if (!service?.enabled) {
      return undefined;
    }
    try {
      return service.getClient();
    } catch {
      return undefined;
    }
  }

  /**
   * Redis service from the options object, else from the registry.
   * Resolved on every access so a late registration still takes effect.
   */
  protected getRedisService(): CoreRedisService | undefined {
    return this.options?.redisService ?? getCronJobsInfrastructure().redisService;
  }

  /**
   * Import the optional peer dependency `bullmq`.
   * Separate method so tests can substitute the module.
   */
  protected importBullMq(): Promise<any> {
    return import('bullmq');
  }

  /**
   * Set up the shared BullMQ queue and worker.
   * Returns whether the BullMQ mode is active.
   */
  protected async initBullMq(): Promise<boolean> {
    const service = this.getRedisService();
    if (!service?.enabled) {
      return false;
    }

    let bullmq: any;
    try {
      bullmq = await this.importBullMq();
    } catch {
      console.warn(
        'Redis is configured but the optional peer dependency "bullmq" is not installed — cron jobs fall back to ' +
          'per-tick MongoDB leases. Run: pnpm add bullmq',
      );
      return false;
    }

    const prefix = `${service.getConfig().keyPrefix}:bull`;
    this.bullQueue = new bullmq.Queue(CRON_QUEUE_NAME, { connection: service.createClient('cron-queue'), prefix });

    const workerConnection = service.createClient('cron-worker');
    // BullMQ blocks on its worker connection and requires unlimited retries there
    (workerConnection as any).options.maxRetriesPerRequest = null;
    this.bullWorker = new bullmq.Worker(CRON_QUEUE_NAME, async (job: any) => this.runTick(job.name), {
      connection: workerConnection,
      prefix,
    });

    return true;
  }

  /**
   * Debug log for a tick that another replica has already claimed
   */
  protected logSkippedTick(leaseKey: string): void {
    if (this.config.log) {
      console.debug(`CronJob tick ${leaseKey} skipped, lease held by another replica`);
    }
  }

  /**
   * Register a job as BullMQ job scheduler
   */
  protected async registerBullJob(name: string, config: CronJobConfigWithTimeZone): Promise<void> {
    await this.bullQueue.upsertJobScheduler(
      name,
      { pattern: config.cronTime as string, tz: config.timeZone ?? undefined },
      { name },
    );

    // A BullMQ scheduler never fires immediately, so runOnInit is emulated locally under a lease.
    // Not awaited, so bootstrap is not blocked by the first run — same as the local timer path.
    if (config.runOnInit) {
      void this.runDistributedTick(name, new Date());
    }

    if (this.config.log) {
      console.info(`CronJob ${name} initialized with "${config.cronTime}" (BullMQ scheduler)`);
    }
  }

  /**
   * Register a job as local cron timer
   */
  protected registerLocalJob(name: string, config: CronJobConfigWithTimeZone, distributed: boolean): void {
    // Filled after construction; runOnInit fires DURING construction, where the fire time is simply "now"
    const ref: { job?: CronJob } = {};

    const job = new CronJob(
      config.cronTime,
      async () => {
        if (distributed) {
          await this.runDistributedTick(name, ref.job?.lastDate() ?? new Date());
          return;
        }
        await this.runTick(name);
      },
      null,
      true,
      config.timeZone,
      config.context,
      config.runOnInit,
      config.utcOffset,
      config.unrefTimeout,
    );
    ref.job = job;
    this.schedulerRegistry.addCronJob(name, job);
    if (this.config.log && this.schedulerRegistry.getCronJob(name)) {
      console.info(`CronJob ${name} initialized with "${config.cronTime}"`);
    }
  }

  /**
   * Run a tick only if this replica wins the lease for it
   */
  protected async runDistributedTick(name: string, fireTime: Date): Promise<void> {
    if (!(await this.acquireLease(name, fireTime))) {
      return;
    }
    await this.runTick(name);
  }

  /**
   * Execute the cron job function, honoring runParallel and throwException.
   * Shared by the local timer and the BullMQ worker.
   */
  protected async runTick(name: string): Promise<void> {
    const config = this.jobConfigs[name];
    if (!config) {
      return;
    }

    // Get current processes of cron job
    const dates = this.runningJobs[name];

    // Check if parallel execution is allowed and if so how many can run in parallel
    if (
      dates?.length &&
      (!config.runParallel || (typeof config.runParallel === 'number' && dates.length >= config.runParallel))
    ) {
      return;
    }

    // Prepare the acquisition of parallel job executions
    if (!this.runningJobs[name]) {
      this.runningJobs[name] = [];
    }
    const date = new Date();
    this.runningJobs[name].push(date);

    // Execute the job and wait until job process is done
    try {
      await this[name]();
    } catch (e) {
      // Remove job from running list
      this.runningJobs[name] = this.runningJobs[name].filter((item) => item !== date);
      if (config.throwException) {
        throw e;
      } else {
        console.error(e);
      }
    }

    // Remove job from running list
    this.runningJobs[name] = this.runningJobs[name].filter((item) => item !== date);
  }

  /**
   * Warn once that cron deduplication is not active
   */
  protected warnDedupInactive(): void {
    if (this.dedupWarned) {
      return;
    }
    this.dedupWarned = true;
    console.warn(
      'Cron job deduplication is inactive: neither a Redis service nor a Mongoose connection was passed to ' +
        'CoreCronJobs. Every replica runs every tick.',
    );
  }
}
