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
 * Lifetime of the `runOnInit` lease.
 *
 * A scheduled tick has an instant every replica agrees on, so its lease key can be derived
 * from the schedule. A STARTUP has no such instant: replicas boot milliseconds to minutes
 * apart, so a key built from each replica's own clock is different on every replica and
 * deduplicates nothing — which, since `runOnInit` defaults to true, would leave the most
 * common path undeduplicated.
 *
 * The init lease therefore uses one fixed key per job plus this TTL, which defines the
 * window in which a fleet counts as "starting up": replicas that boot within it run the
 * init tick once between them, and a replica joining later (autoscaling, a much later
 * restart) runs it again — which is the intended behavior for a newly started instance.
 */
const CRON_INIT_LOCK_TTL_SECONDS = 300;

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
    await this.drainRunningJobs();

    // Settled, not sequential-and-throwing: a rejection from the worker's close would abort the
    // whole chain, leaving the queue open and its Redis connections dangling — so a shutdown
    // hiccup in one component would strand the others.
    const results = await Promise.allSettled([this.bullWorker?.close(), this.bullQueue?.close()]);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('BullMQ shutdown failed', result.reason);
      }
    }
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
    const bullScheduled = new Set<string>();

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
        // Deduplication follows "presence implies enabled": without a `redis` config the
        // service must behave exactly as before, so a single-replica project that upgrades
        // does not silently gain a `cron-locks` collection, a lease write per tick, and a
        // new way for a tick to be skipped. The MongoDB lease stays available for a
        // multi-replica fleet that runs without Redis — via an explicit `distributed: true`.
        distributed: !!this.getRedisService()?.enabled,
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
          bullScheduled.add(name);
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

    await this.removeStaleBullSchedulers(bullScheduled);
    this.startBullWorker();
  }

  /**
   * Acquire the lease for a single tick.
   *
   * Returns `true` when this replica may run the tick — including when no lease
   * backend is available at all (fail open: a missing lock must never stop the job).
   */
  protected async acquireLease(name: string, fireTime: Date | 'init' | 'manual'): Promise<boolean> {
    // 'manual' is an operator-triggered run: they asked for THIS execution, so it must not be
    // deduplicated against a scheduled tick, and it is one replica acting deliberately rather
    // than N replicas racing. Hence a unique key rather than a shared one.
    const leaseKey =
      fireTime === 'manual'
        ? `${name}:manual:${Date.now()}:${process.pid}`
        : fireTime === 'init'
          ? `${name}:init`
          : `${name}:${new Date(Math.floor(fireTime.getTime() / 1000) * 1000).toISOString()}`;
    const ttlSeconds = fireTime === 'init' ? CRON_INIT_LOCK_TTL_SECONDS : CRON_LOCK_TTL_SECONDS;

    const redis = this.getRedisClient();
    if (redis) {
      try {
        const acquired = await redis.set(
          this.getRedisService().key('cron-lock', leaseKey),
          '1',
          'EX',
          ttlSeconds,
          'NX',
        );
        if (acquired === null) {
          this.logSkippedTick(leaseKey);
          return false;
        }
        return true;
      } catch (e) {
        // Fail open, exactly like the Mongo branch below: a lease is there to prevent a
        // DUPLICATE run, and treating an unreachable Redis as "someone else won" would
        // instead stop every scheduled job on every replica — a silent, fleet-wide outage
        // of all cron work, which is the worse failure of the two.
        console.error(`Cron lease for ${leaseKey} failed on Redis, running the tick anyway`, e);
        return true;
      }
    }

    const connection = this.getConnection();
    if (!connection) {
      this.warnDedupInactive();
      return true;
    }

    await this.ensureLeaseIndex(connection);
    try {
      await connection.db.collection(CRON_LOCK_COLLECTION).insertOne({
        _id: leaseKey as any,
        createdAt: new Date(),
        // Per-document expiry, so the short init window and the long tick window can
        // share one collection (a fixed expireAfterSeconds could only express one).
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      });
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
      // expireAfterSeconds: 0 means "expire AT the date in this field", which lets each
      // lease carry its own lifetime (see the insert in acquireLease).
      this.leaseIndexReady = connection.db
        .collection(CRON_LOCK_COLLECTION)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
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

    // BullMQ owns the lifetime of its commands and must be exempt from the shared defaults:
    // its fetch loop issues a BLOCKING BZPOPMIN that waits up to 10s on purpose, so the
    // `commandTimeout` every other connection carries would abort it. BullMQ then classifies
    // the abort as a real error, emits it, and stops fetching — silently ending all cron work
    // in the fleet. It also requires unlimited retries on a blocking connection.
    const blockingOptions = { commandTimeout: undefined, maxRetriesPerRequest: null };

    // The QUEUE issues ordinary, non-blocking commands and must NOT inherit the opt-out above.
    // `maxRetriesPerRequest: null` tells ioredis to retry forever and never flush the offline
    // queue with an error — so against an unreachable Redis `upsertJobScheduler()` neither
    // resolves nor rejects. Since initCronJobs() is awaited from onApplicationBootstrap, which
    // runs BEFORE app.listen(), that turns a Redis outage at boot into a process that hangs
    // silently: no health endpoint, no readiness, no error, no log. Bounded retries make the
    // same outage a real rejection that the caller can report.
    const queueOptions = { commandTimeout: 10_000, maxRetriesPerRequest: 3 };

    this.bullQueue = new bullmq.Queue(CRON_QUEUE_NAME, {
      connection: service.createClient('cron-queue', queueOptions),
      prefix,
    });

    const workerConnection = service.createClient('cron-worker', blockingOptions);
    // autorun: false — initBullMq() runs BEFORE the loop that fills `jobConfigs`, so a worker
    // that starts consuming here would hand `runTick` a job it has no config for. That path
    // returns without throwing, which BullMQ records as COMPLETED: the tick is lost silently
    // and never retried. Consumption starts in startBullWorker(), after registration.
    this.bullWorker = new bullmq.Worker(CRON_QUEUE_NAME, async (job: any) => this.runTick(job.name), {
      autorun: false,
      connection: workerConnection,
      prefix,
    });

    // Without a listener an emitted 'error' is an UNHANDLED 'error' event, which rejects the
    // promise from run() and takes the fetch loop down with it — after which no replica runs
    // any job again. A transient error must stay transient.
    this.bullWorker.on('error', (error: Error) => {
      console.error(`BullMQ cron worker error: ${error.message}`);
    });

    return true;
  }

  /**
   * Give a tick that is already running a bounded chance to finish.
   *
   * `runningJobs` is the only record that a job is mid-execution. Closing the worker out from
   * under it abandons the work AND leaves its lease held for the rest of the TTL, so the next
   * replica skips that tick too — the job silently does not happen. Waiting is bounded because a
   * job that runs longer than the orchestrator's grace period cannot be saved either way; it is
   * better to say so than to hang the shutdown.
   */
  protected async drainRunningJobs(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const running = () => Object.values(this.runningJobs).reduce((sum, dates) => sum + (dates?.length ?? 0), 0);

    if (!running()) {
      return;
    }
    console.info(`Waiting up to ${timeoutMs}ms for ${running()} running cron job(s) to finish`);

    while (running() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (running()) {
      console.warn(`${running()} cron job(s) still running after ${timeoutMs}ms — shutting down anyway`);
    }
  }

  /**
   * Drop schedulers in the shared queue that this version no longer registers.
   *
   * `upsertJobScheduler` writes PERMANENT state into Redis, while the config that justifies it
   * lives only in the process-local `jobConfigs`. Disabling a job, renaming it, removing it from
   * `cronJobs`, or switching it to `distributed: false` therefore only stops re-registering it —
   * the scheduler keeps producing queue jobs forever. Every replica then drops them with the
   * "no registered config" warning, and in the `distributed: false` case they duplicate the
   * local timer.
   */
  protected async removeStaleBullSchedulers(active: Set<string>): Promise<void> {
    if (!this.bullQueue) {
      return;
    }
    try {
      // Only schedulers this application configured are candidates. The queue name and prefix
      // derive from `keyPrefix`, whose default is shared — two apps (or a dev and a staging
      // deployment) pointing at one Redis without overriding it would otherwise wipe each
      // other's schedulers on every boot. `known` is every job name in OUR config, so a job that
      // exists but is currently disabled or non-distributed is still recognised as ours.
      const known = new Set(Object.keys(this.cronJobs ?? {}));
      for (const scheduler of await this.bullQueue.getJobSchedulers()) {
        if (scheduler?.key && known.has(scheduler.key) && !active.has(scheduler.key)) {
          await this.bullQueue.removeJobScheduler(scheduler.key);
          console.info(`CronJob scheduler ${scheduler.key} removed — no longer configured`);
        }
      }
    } catch (error) {
      // Reconciliation is housekeeping: a failure here must not stop the jobs from starting.
      console.warn('Failed to reconcile BullMQ job schedulers', error);
    }
  }

  /**
   * Start consuming once every job config is registered.
   *
   * Concurrency matches the number of registered jobs: BullMQ defaults to 1, which would put
   * every job behind a single slow one — something one-timer-per-job never did, and which
   * would also make `runParallel` unreachable.
   */
  protected startBullWorker(): void {
    if (!this.bullWorker) {
      return;
    }
    this.bullWorker.concurrency = Math.max(1, Object.keys(this.jobConfigs).length);
    this.bullWorker.run().catch((e: unknown) => console.error('BullMQ cron worker stopped', e));
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
    // That also means nothing is there to catch a rejection, and `runTick` re-throws when
    // `throwException` is set (the default): without the catch below, a job that throws on
    // its startup run takes the process down with an unhandled rejection.
    if (config.runOnInit) {
      this.runInitTick(name);
    }

    // Register a STOPPED local CronJob as the registry entry for this job.
    //
    // `SchedulerRegistry` is the only thing the Hub's cron panel reads, so without an entry a
    // BullMQ-scheduled job is invisible there and every start/stop/trigger action throws for a
    // job that plainly exists. It is created with `start = false` so it never fires on its own —
    // the BullMQ scheduler owns the schedule — while `nextDate()`/`lastDate()` still answer for
    // the panel, and a manual trigger goes through the same leased tick as everywhere else.
    if (!this.schedulerRegistry.doesExist('cron', name)) {
      const registryJob = new CronJob(
        config.cronTime,
        () => this.runInitTick(name),
        null,
        false,
        config.timeZone,
        config.context,
        false,
        config.utcOffset,
        config.unrefTimeout,
      );
      this.schedulerRegistry.addCronJob(name, registryJob);
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
    /** Fire time of the last SCHEDULED tick, to tell a manual trigger apart from a repeat */
    let lastLeasedFireTime: number | undefined;

    const job = new CronJob(
      config.cronTime,
      async () => {
        if (distributed) {
          // The runOnInit fire happens DURING construction, so `ref.job` is not assigned
          // yet — that absence is exactly how the startup run identifies itself. It takes
          // the fleet-wide init lease, because "startup" is not an instant the replicas
          // agree on; a scheduled tick takes a lease keyed on the schedule instant, which
          // every replica computes identically.
          const scheduled = ref.job?.lastDate();
          if (!scheduled) {
            this.runInitTick(name);
            return;
          }
          // `cron` only advances lastDate() on a SCHEDULED fire, so a manual fireOnTick() (the
          // Hub's "Run now") reports the previous tick's instant — whose lease this replica
          // already holds. Reusing it would lose the race against itself and silently do
          // nothing, while the operator sees a success response. A manual run gets its own key.
          if (scheduled.getTime() === lastLeasedFireTime) {
            await this.runDistributedTick(name, 'manual');
            return;
          }
          lastLeasedFireTime = scheduled.getTime();
          await this.runDistributedTick(name, scheduled);
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
  protected async runDistributedTick(name: string, fireTime: Date | 'init' | 'manual'): Promise<void> {
    if (!(await this.acquireLease(name, fireTime))) {
      return;
    }
    await this.runTick(name);
  }

  /**
   * Fire the `runOnInit` tick without blocking bootstrap and without letting a failure
   * escape as an unhandled rejection.
   */
  protected runInitTick(name: string): void {
    this.runDistributedTick(name, 'init').catch((e) => {
      console.error(`CronJob ${name} failed on its startup run`, e);
    });
  }

  /**
   * Execute the cron job function, honoring runParallel and throwException.
   * Shared by the local timer and the BullMQ worker.
   */
  protected async runTick(name: string): Promise<void> {
    const config = this.jobConfigs[name];
    if (!config) {
      // Returning quietly here is how a mis-timed BullMQ delivery got recorded as a
      // successful, completed tick. The guard stays, but it no longer stays silent.
      console.warn(`CronJob tick for "${name}" dropped — no registered config`);
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
