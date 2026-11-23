import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob, CronTime } from 'cron';

import { CronJobConfigWithTimeZone } from '../interfaces/cron-job-config-with-time-zone.interface.js';
import { CronJobConfigWithUtcOffset } from '../interfaces/cron-job-config-with-utc-offset.interface.js';
import { CRON_LOCK_COLLECTION, cronMongoLocks, defaultSqlLockStore } from '../persistence/infrastructure-locks.js';
import { Falsy } from '../types/falsy.type.js';
import { getCronJobsInfrastructure } from './core-cron-jobs.registry.js';

import type { LockStore } from '../persistence/lock-store.interface.js';
import type { CoreRedisService } from './core-redis.service.js';
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';

/**
 * One logger for every cron message, through Nest's logger so levels, JSON mode and a project's custom logger apply.
 * Module-level rather than a class member on purpose: a project `CronJobs extends CoreCronJobs` that declares its
 * own `logger` field (a common shape) would otherwise stop compiling.
 */
const cronLogger = new Logger('CronJobs');

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorStack = (error: unknown): string | undefined => (error instanceof Error ? error.stack : undefined);

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
 * Lifetime of the lease a `runParallel: false` job holds while it RUNS, renewed every third of it.
 *
 * Short, so a replica that dies mid-run frees the job within a minute; the heartbeat keeps it held for as long as the
 * run takes.
 */
const CRON_RUNNING_LOCK_TTL_SECONDS = 60;

/** Extends a Redis lease only for its owner */
const REDIS_RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

/** Deletes a Redis lease only for its owner */
const REDIS_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Jobs one `clean()` call removes when the backlog of earlier versions is trimmed: about 6.5 ms of Redis time each, so
 * Redis keeps answering other clients between the calls
 */
const CRON_JOB_TRIM_BATCH = 1000;

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
 * A new schedule for {@link CoreCronJobs.rescheduleCronJob}: a cron expression or a date (the job keeps its time zone
 * or UTC offset), or the schedule fields of a job config. Only the schedule changes — `distributed`, `runParallel`,
 * `throwException` and the job function stay as configured.
 */
export type CronJobSchedule =
  | CronExpression
  | Date
  | Pick<CronJobConfigWithTimeZone, 'cronTime' | 'timeZone' | 'utcOffset'>
  | Pick<CronJobConfigWithUtcOffset, 'cronTime' | 'timeZone' | 'utcOffset'>
  | string;

/**
 * Cron jobs service to extend
 *
 * Jobs are deduplicated across replicas when they are `distributed` — the default with `redis` configured; without
 * it a job runs on every replica unless it sets `distributed: true`:
 * - Redis configured + `bullmq` installed: the job becomes a BullMQ job scheduler,
 *   so exactly one worker in the cluster picks up each tick.
 * - Otherwise: the local cron timer stays, but each tick first acquires a lease
 *   (Redis `SET NX` when available, else the SQL lease table of the default source, else a `cron-locks` document in
 *   MongoDB).
 *
 * A job's schedule can be changed at runtime with {@link CoreCronJobs.rescheduleCronJob} (12.11.0), in both modes.
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

  /**
   * Options of every job a BullMQ scheduler creates (DEV-3896). One attempt: a failed tick is not repeated, as with the
   * local timer — the next tick runs on schedule, and a retry could repeat side effects of a run that failed halfway.
   * Completed and failed jobs are trimmed, one job per tick would otherwise stay in Redis for good. A subclass may set
   * its own.
   */
  protected bullJobOptions: Record<string, unknown> = {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  };

  /** Shared BullMQ queue, created only in BullMQ mode */
  protected bullQueue?: any;

  /** Redis connection of the shared queue; its `ready` event triggers the scheduler check after a reconnect */
  protected bullQueueConnection?: any;

  /** Names of the jobs registered as BullMQ job schedulers, i.e. the schedules that must exist in Redis */
  protected bullScheduledJobs = new Set<string>();

  /** Running scheduler check, so a reconnect and the timer never check twice at once */
  protected bullSchedulerCheck?: Promise<void>;

  /**
   * How often to check that every BullMQ scheduler still exists in Redis, in ms. `0` switches the time-based check
   * off; the check after a reconnect of the queue connection stays. See restoreBullSchedulers().
   */
  protected bullSchedulerCheckIntervalMs = 60_000;

  /** Timer of the periodic scheduler check */
  protected bullSchedulerCheckTimer?: ReturnType<typeof setInterval>;

  /** Shared BullMQ worker, created only in BullMQ mode */
  protected bullWorker?: any;

  /** Set when the application shuts down: no job is (re)scheduled after that */
  protected cronJobsClosed = false;

  /** Whether the "deduplication inactive" warning was already emitted */
  protected dedupWarned = false;

  /** Normalized config per job name, used by the tick wrapper of both modes */
  protected jobConfigs: Record<string, CronJobConfigWithTimeZone> = {};

  /** Cached creation of the TTL index on the lock collection */
  protected leaseIndexReady?: Promise<void>;

  /**
   * Owner of the leases this instance takes. Per-tick keys are unique, so the owner only names who ran a tick; the
   * lease collection (`cron-locks`, no Mongoose schema — native access is correct, see
   * docs/native-driver-security.md) keeps the 12.0.0 document so older replicas dedupe against it
   */
  protected readonly leaseOwner = `cron:${process.pid}:${Math.random().toString(36).slice(2)}`;

  /**
   * Listener for the `ready` event of the queue connection. An arrow function, so shutdown can remove exactly this
   * listener. `void` is safe: restoreBullSchedulers() catches every failure per job and never rejects.
   */
  protected readonly onBullQueueReady = (): void => {
    void this.restoreBullSchedulers();
  };

  /** The reschedule in progress; rescheduleCronJob() calls run one after the other */
  protected rescheduling: Promise<void> = Promise.resolve();

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
      cronLogger.log('Init CronJobs after application bootstrap');
    }
    await this.initCronJobs();
  }

  /**
   * Close the BullMQ worker and queue
   */
  async onApplicationShutdown(): Promise<void> {
    this.cronJobsClosed = true;
    // A reschedule already running finishes first; it never rejects here (rescheduleCronJob() reports to its caller)
    await this.rescheduling;
    this.stopBullSchedulerCheck();
    // A check already running finishes its current job before the queue closes; it never rejects.
    await this.bullSchedulerCheck;
    await this.drainRunningJobs();

    // Settled, not sequential-and-throwing: a rejection from the worker's close would abort the
    // whole chain, leaving the queue open and its Redis connections dangling — so a shutdown
    // hiccup in one component would strand the others.
    const results = await Promise.allSettled([this.bullWorker?.close(), this.bullQueue?.close()]);
    for (const result of results) {
      if (result.status === 'rejected') {
        cronLogger.error(`BullMQ shutdown failed: ${errorMessage(result.reason)}`, errorStack(result.reason));
      }
    }
    this.bullWorker = undefined;
    this.bullQueue = undefined;
  }

  // ===================================================================================================================
  // Runtime changes
  // ===================================================================================================================

  /**
   * Change the schedule of a registered cron job at runtime (12.11.0) — for a schedule a project keeps in its own
   * settings rather than in the `cronJobs` configuration.
   *
   * `schedule` is a cron expression or a date (the job keeps its time zone or UTC offset), or `{ cronTime, timeZone }` /
   * `{ cronTime, utcOffset }`. It is validated before anything changes: an invalid expression, an unknown time zone or
   * a date in the past rejects and leaves the job as it was. Only the schedule changes; `distributed`, `runParallel`
   * and `throwException` stay as configured, and so do the leases, the running lease and the BullMQ job options.
   *
   * - Local timer: the timer is replaced. The next tick follows the new schedule, a distributed job takes its tick
   *   lease keyed on the new schedule's instant, a tick that is running finishes. A recurring job the Hub stopped on
   *   this replica stays stopped.
   * - BullMQ job scheduler: the scheduler is written to Redis with the new pattern and `bullJobOptions` — skipped when
   *   Redis already holds exactly this pattern and time zone, so calling this on every replica plans no tick twice —
   *   and restoreBullSchedulers() brings the NEW schedule back after a data loss. A schedule BullMQ cannot express (a
   *   date, a UTC offset) moves the job to a local timer with lease: its scheduler is removed with the removal marker,
   *   so a replica that still schedules the job through BullMQ does not bring it back. A cron expression moves the job
   *   back to BullMQ.
   *
   * WHERE IT APPLIES: a BullMQ scheduler lives in Redis and changes for the whole fleet at once, a local timer only in
   * this process. Call it on EVERY replica (from the settings change each replica observes, and at startup), or the
   * replicas run the job on different schedules. A reschedule is not stored: the next bootstrap schedules the job from
   * the configuration again, so a project re-applies a stored schedule after `super.onApplicationBootstrap()`.
   *
   * `runOnInit` is not repeated — a reschedule is not a start. Calls run one after the other. Rejects for a job that is
   * not registered: unknown, disabled, without `cronTime` or job method, before bootstrap or after shutdown.
   */
  async rescheduleCronJob(name: string, schedule: CronJobSchedule): Promise<void> {
    const run = this.rescheduling.then(() => this.applyCronJobSchedule(name, schedule));
    this.rescheduling = run.catch(() => undefined);
    return run;
  }

  /**
   * Apply a new schedule to a registered job: validate it, then move the job to the mode the schedule needs — the same
   * rule initCronJobs() applies (BullMQ for a distributed job with a cron expression and no UTC offset while BullMQ is
   * active, a local timer otherwise). See rescheduleCronJob().
   */
  protected async applyCronJobSchedule(name: string, schedule: CronJobSchedule): Promise<void> {
    const current = this.jobConfigs[name];
    const scheduledWithBull = this.bullScheduledJobs.has(name);
    if (this.cronJobsClosed || !current || (!scheduledWithBull && !this.schedulerRegistry.doesExist('cron', name))) {
      throw new Error(`CronJob ${name} is not registered and cannot be rescheduled`);
    }
    const next = this.withSchedule(name, current, schedule);
    // sendAt() refuses what has no next instant (a date in the past); the constructor an invalid expression or zone
    new CronTime(next.cronTime as any, next.timeZone as any, next.utcOffset as any).sendAt();

    // A scheduler check that runs finishes before the job changes under it
    await this.bullSchedulerCheck;
    const withBull = !!this.bullQueue && next.distributed !== false && this.canUseBullScheduler(next);
    if (withBull) {
      await this.rescheduleWithBull(name, next);
    } else {
      await this.rescheduleLocally(name, next, scheduledWithBull);
    }

    if (this.config.log) {
      const cronTime = next.cronTime instanceof Date ? next.cronTime.toISOString() : String(next.cronTime);
      cronLogger.log(`CronJob ${name} rescheduled to "${cronTime}" (${withBull ? 'BullMQ scheduler' : 'local timer'})`);
    }
  }

  /** The job's config with the new schedule; a cron expression or date keeps the time zone or UTC offset */
  protected withSchedule(
    name: string,
    current: CronJobConfigWithTimeZone,
    schedule: CronJobSchedule,
  ): CronJobConfigWithTimeZone {
    if (typeof schedule === 'string' || schedule instanceof Date) {
      return { ...current, cronTime: schedule };
    }
    if (!schedule || typeof schedule !== 'object' || !schedule.cronTime) {
      throw new Error(`CronJob ${name} cannot be rescheduled without a cronTime`);
    }
    const next: Record<string, unknown> = { ...current, cronTime: schedule.cronTime };
    if (schedule.utcOffset !== undefined && schedule.utcOffset !== null) {
      // timeZone and utcOffset exclude each other, as in initCronJobs()
      next.timeZone = null;
      next.utcOffset = schedule.utcOffset;
    } else if (schedule.timeZone) {
      next.timeZone = schedule.timeZone;
      next.utcOffset = undefined;
    }
    return next as unknown as CronJobConfigWithTimeZone;
  }

  /** Whether BullMQ can express a schedule: a cron expression without a UTC offset (BullMQ knows only time zones) */
  protected canUseBullScheduler(config: CronJobConfigWithTimeZone): boolean {
    return typeof config.cronTime === 'string' && !config.utcOffset;
  }

  /**
   * Reschedule a job through its BullMQ scheduler — or move it there from a local timer. Redis is written first: when
   * that fails, the job keeps running as it did and the call rejects.
   */
  protected async rescheduleWithBull(name: string, config: CronJobConfigWithTimeZone): Promise<void> {
    const previous = this.jobConfigs[name];
    // The schedule restoreBullSchedulers() brings back after a data loss
    this.jobConfigs[name] = config;
    try {
      // The job runs through BullMQ again, so a removal marker an earlier schedule left no longer applies
      const removedKey = this.bullSchedulerRemovedKey(name);
      if (removedKey) {
        await this.getRedisClient()?.del(removedKey);
      }
      if (!(await this.bullSchedulerMatches(name, config))) {
        await this.upsertBullScheduler(name, config);
      }
    } catch (error) {
      this.jobConfigs[name] = previous;
      throw error;
    }
    this.bullScheduledJobs.add(name);
    // The local timer the job ran on, or the stopped registry entry of its previous schedule
    this.removeCronJobRegistryEntry(name);
    this.schedulerRegistry.addCronJob(name, this.createBullRegistryEntry(name, config));
    if (!this.bullSchedulerCheckTimer) {
      this.startBullSchedulerCheck();
    }
  }

  /**
   * Reschedule a job on a local timer — or move it there from its BullMQ scheduler, which is removed with the removal
   * marker first: a replica that still schedules the job through BullMQ must not register it again.
   */
  protected async rescheduleLocally(
    name: string,
    config: CronJobConfigWithTimeZone,
    scheduledWithBull: boolean,
  ): Promise<void> {
    if (scheduledWithBull) {
      this.bullScheduledJobs.delete(name);
      try {
        await this.markBullSchedulerRemoved(name);
        await this.bullQueue?.removeJobScheduler(name);
      } catch (error) {
        // The job stays with its scheduler; a marker written before the removal failed would hide a later data loss
        this.bullScheduledJobs.add(name);
        try {
          const removedKey = this.bullSchedulerRemovedKey(name);
          if (removedKey) {
            await this.getRedisClient()?.del(removedKey);
          }
        } catch {
          // Redis is not answering — the next registerBullJob() deletes the marker
        }
        throw error;
      }
    }
    const previous = scheduledWithBull ? undefined : this.registeredCronJob(name);
    // The Hub stopped a recurring job on this replica: the new timer stays stopped too (a one-shot date stops itself)
    const keepStopped = !!previous && !previous.isActive && !previous.cronTime?.realDate;
    this.removeCronJobRegistryEntry(name);
    this.jobConfigs[name] = config;
    // A reschedule is not a start: no runOnInit
    this.registerLocalJob(name, { ...config, runOnInit: false }, config.distributed !== false);
    if (keepStopped) {
      void this.registeredCronJob(name)?.stop();
    }
  }

  /**
   * Whether Redis already holds this job's scheduler with exactly this pattern and time zone. An upsert is not free —
   * BullMQ drops the tick the scheduler planned last and plans from now — so an unchanged schedule is not written again.
   * A listing that fails answers `false`: the schedule is then written.
   */
  protected async bullSchedulerMatches(name: string, config: CronJobConfigWithTimeZone): Promise<boolean> {
    try {
      const listed: { key?: string; pattern?: string; tz?: null | string }[] = await this.bullQueue.getJobSchedulers();
      const scheduler = listed.find((entry) => entry?.key === name);
      return (
        !!scheduler &&
        scheduler.pattern === config.cronTime &&
        (scheduler.tz ?? undefined) === (config.timeZone ?? undefined)
      );
    } catch {
      return false;
    }
  }

  /**
   * The STOPPED CronJob that stands for a BullMQ-scheduled job in the SchedulerRegistry — see registerBullJob(). It never
   * fires on its own; the Hub reads its schedule, and a manual trigger runs the leased tick.
   */
  protected createBullRegistryEntry(name: string, config: CronJobConfigWithTimeZone): CronJob {
    return new CronJob(
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
  }

  /** The job's CronJob in the SchedulerRegistry, if it has one */
  protected registeredCronJob(name: string): CronJob | undefined {
    return this.schedulerRegistry.doesExist('cron', name) ? this.schedulerRegistry.getCronJob(name) : undefined;
  }

  /** Stop the job's CronJob and take it out of the SchedulerRegistry (deleteCronJob() stops it) */
  protected removeCronJobRegistryEntry(name: string): void {
    if (this.schedulerRegistry.doesExist('cron', name)) {
      this.schedulerRegistry.deleteCronJob(name);
    }
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
    if (bullMqActive) {
      await this.trimBullJobBacklog();
    }
    this.bullScheduledJobs.clear();
    /** Jobs that run on every replica because no redis is configured and they did not choose either way */
    const localByDefault: string[] = [];

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
          cronLogger.warn(`Missing cron job function ${name}`);
        }
        continue;
      }

      this.jobConfigs[name] = config;
      const distributed = config.distributed !== false;

      // Init cron job as BullMQ job scheduler, when possible
      if (bullMqActive && distributed) {
        if (this.canUseBullScheduler(config)) {
          await this.registerBullJob(name, config);
          this.bullScheduledJobs.add(name);
          continue;
        }
        cronLogger.debug(
          `CronJob ${name} cannot be expressed as BullMQ scheduler (${
            typeof config.cronTime === 'string' ? 'utcOffset is set' : 'cronTime is a Date'
          }), falling back to a local timer with lease`,
        );
      }

      // Init local cron job
      this.registerLocalJob(name, config, distributed);
      if (!distributed && conf.distributed === undefined) {
        localByDefault.push(name);
      }
    }

    this.logLocalJobsHint(localByDefault);
    await this.removeStaleBullSchedulers(this.bullScheduledJobs);
    this.startBullWorker();
    this.startBullSchedulerCheck();
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
        cronLogger.error(
          `Cron lease for ${leaseKey} failed on Redis, running the tick anyway: ${errorMessage(e)}`,
          errorStack(e),
        );
        return true;
      }
    }

    const sqlLocks = await defaultSqlLockStore('cron').catch((e) => {
      cronLogger.error(`Cron lease store unavailable, running the tick anyway: ${errorMessage(e)}`, errorStack(e));
      return null;
    });
    if (sqlLocks === null) {
      return true;
    }
    const connection = sqlLocks ? undefined : this.getConnection();
    if (!sqlLocks && !connection) {
      this.warnDedupInactive();
      return true;
    }

    try {
      let acquired: boolean;
      if (sqlLocks) {
        acquired = await sqlLocks.tryAcquire(leaseKey, this.leaseOwner, ttlSeconds);
      } else {
        // The TTL index only collects old leases — for this version and for older replicas, which still claim with a
        // plain insert. Whether a lease is free is decided by its expiresAt (LockStore), never by the TTL monitor.
        await this.ensureLeaseIndex(connection);
        acquired = await cronMongoLocks(connection.db.collection(CRON_LOCK_COLLECTION)).tryAcquire(
          leaseKey,
          this.leaseOwner,
          ttlSeconds,
        );
      }
      if (!acquired) {
        this.logSkippedTick(leaseKey);
      }
      return acquired;
    } catch (e) {
      cronLogger.error(`Cron lease for ${leaseKey} failed, running the tick anyway: ${errorMessage(e)}`, errorStack(e));
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
          // Tried again on the next tick: cached as done, the index would never exist and `cron-locks` would grow
          // without bound (DEV-3896). The lease itself does not need it — expiry is decided by expiresAt.
          this.leaseIndexReady = undefined;
          cronLogger.error(`Could not create TTL index on cron lock collection: ${errorMessage(e)}`, errorStack(e));
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
    } catch (error) {
      cronLogger.warn(
        `Redis is configured but the optional peer dependency "bullmq" could not be loaded (${errorMessage(error)}) — ` +
          'cron jobs fall back to per-tick MongoDB leases. If it is missing: pnpm add bullmq',
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

    const queueConnection = service.createClient('cron-queue', queueOptions);
    this.bullQueue = new bullmq.Queue(CRON_QUEUE_NAME, {
      connection: queueConnection,
      prefix,
    });

    // A Redis or Valkey restart without persistence loses every scheduler, and the reconnect is the first moment a
    // replica can notice it — see restoreBullSchedulers().
    this.bullQueueConnection = queueConnection;
    queueConnection.on?.('ready', this.onBullQueueReady);

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
      cronLogger.error(`BullMQ cron worker error: ${error.message}`, error.stack);
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
    cronLogger.log(`Waiting up to ${timeoutMs}ms for ${running()} running cron job(s) to finish`);

    while (running() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (running()) {
      cronLogger.warn(`${running()} cron job(s) still running after ${timeoutMs}ms — shutting down anyway`);
    }
  }

  /**
   * Trim the finished cron jobs earlier versions kept, in bounded batches, before the schedulers get `bullJobOptions`.
   *
   * Up to 12.1.0 every completed and failed tick stayed in Redis. BullMQ trims by `count` in ONE Lua call without a
   * limit, so the first tick to finish under the new options would delete the whole backlog at once — measured 2 s for
   * 300k jobs and 4.4 s for 700k, during which Redis answers nobody and every command of every replica times out
   * (DEV-3896). `clean()` removes the oldest first and honours its limit. Once the backlog is gone this is one count
   * per type at bootstrap. A failure is reported and does not stop the jobs.
   */
  protected async trimBullJobBacklog(): Promise<void> {
    const keep = {
      completed: (this.bullJobOptions.removeOnComplete as { count?: number } | undefined)?.count,
      failed: (this.bullJobOptions.removeOnFail as { count?: number } | undefined)?.count,
    };
    for (const type of ['completed', 'failed'] as const) {
      const limit = keep[type];
      if (typeof limit !== 'number' || limit < 0) {
        continue;
      }
      try {
        let excess = (await this.bullQueue.getJobCountByTypes(type)) - limit;
        if (excess <= 0) {
          continue;
        }
        cronLogger.log(`Trimming ${excess} ${type} cron jobs an earlier version kept in Redis`);
        while (excess > 0) {
          const removed: string[] = await this.bullQueue.clean(0, Math.min(CRON_JOB_TRIM_BATCH, excess), type);
          if (!removed?.length) {
            break;
          }
          excess -= removed.length;
        }
      } catch (error) {
        cronLogger.warn(`Trimming the ${type} cron jobs failed: ${errorMessage(error)}`);
      }
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
          await this.markBullSchedulerRemoved(scheduler.key);
          cronLogger.log(`CronJob scheduler ${scheduler.key} removed — no longer configured`);
        }
      }
    } catch (error) {
      // Reconciliation is housekeeping: a failure here must not stop the jobs from starting.
      cronLogger.warn(`Failed to reconcile BullMQ job schedulers: ${errorMessage(error)}`);
    }
  }

  /**
   * Register every BullMQ scheduler again that Redis no longer has.
   *
   * `upsertJobScheduler` writes a schedule into Redis once, at bootstrap. A Redis or Valkey restart without
   * persistence, a FLUSHDB or an eviction under `maxmemory` removes it, and before 12.1.1 nothing registered it
   * again: no replica ran the job until the next deploy, without a log line, because the worker kept polling an empty
   * queue. This runs after every reconnect of the queue connection and every `bullSchedulerCheckIntervalMs`.
   *
   * Only MISSING schedulers are registered. An upsert of an existing one is not free: BullMQ removes the job the
   * scheduler planned last, also one that is already due and waits for a free worker slot, and plans the next one
   * from now, so the due tick would be lost. Replicas that find a scheduler missing at the same moment may both
   * register it; the second upsert replaces the first one's job with an identical one.
   *
   * Which schedulers exist comes from the LISTING, not from `getJobScheduler()`: that method does not exist before
   * bullmq 5.23, and up to 5.40.2 it answers a deleted scheduler with an object instead of `undefined` — both inside
   * the peer range. A scheduler a newer version removed on purpose (see markBullSchedulerRemoved()) stays removed.
   *
   * Only the schedule comes back: `runOnInit` and the registry entry belong to bootstrap. A tick that fell due while
   * the scheduler was gone is not run.
   */
  protected restoreBullSchedulers(): Promise<void> {
    if (!this.bullSchedulerCheck) {
      this.bullSchedulerCheck = (async () => {
        if (!this.bullQueue || !this.bullScheduledJobs.size) {
          return;
        }
        const present = await this.listBullSchedulerKeys();
        if (!present) {
          return;
        }
        for (const name of this.bullScheduledJobs) {
          const config = this.jobConfigs[name];
          if (!this.bullQueue || !config || present.has(name)) {
            continue;
          }
          try {
            if (await this.isBullSchedulerRemoved(name)) {
              continue;
            }
            await this.upsertBullScheduler(name, config);
            cronLogger.warn(`CronJob scheduler ${name} was missing in Redis and has been registered again`);
          } catch (error) {
            cronLogger.warn(`Failed to check the BullMQ scheduler of CronJob ${name}: ${errorMessage(error)}`);
          }
        }
      })().finally(() => {
        this.bullSchedulerCheck = undefined;
      });
    }
    return this.bullSchedulerCheck;
  }

  /** Keys of the schedulers the shared queue holds, or `undefined` when the listing failed (logged) */
  protected async listBullSchedulerKeys(): Promise<Set<string> | undefined> {
    try {
      const schedulers: { key?: string }[] = await this.bullQueue.getJobSchedulers();
      return new Set(schedulers.map((scheduler) => scheduler?.key).filter((key): key is string => !!key));
    } catch (error) {
      cronLogger.warn(`Failed to list the BullMQ job schedulers: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Redis key marking a scheduler that removeStaleBullSchedulers() removed on purpose
   *
   * In a rolling deploy the new version's bootstrap removes the scheduler of a job it no longer runs through BullMQ,
   * while replicas of the old version still have that job in `bullScheduledJobs`. Their check finds the scheduler
   * missing and would register it again; for a job moved to a local timer that is a second run every tick until the
   * next deploy. The marker tells them the scheduler is gone on purpose. registerBullJob() deletes it, and a real data
   * loss takes it along with the schedulers, so restoring still works then.
   */
  protected bullSchedulerRemovedKey(name: string): string | undefined {
    return this.getRedisService()?.key('cron-scheduler-removed', name);
  }

  /** Whether a newer configuration removed this job's scheduler on purpose; see bullSchedulerRemovedKey() */
  protected async isBullSchedulerRemoved(name: string): Promise<boolean> {
    const key = this.bullSchedulerRemovedKey(name);
    return !!key && !!(await this.getRedisClient()?.get(key));
  }

  /** Record that this job's scheduler was removed on purpose; see bullSchedulerRemovedKey() */
  protected async markBullSchedulerRemoved(name: string): Promise<void> {
    const key = this.bullSchedulerRemovedKey(name);
    if (key) {
      await this.getRedisClient()?.set(key, new Date().toISOString());
    }
  }

  /**
   * Arm the periodic scheduler check. Only the reconnect notices a Redis restart; a FLUSHDB or an eviction closes no
   * connection, so only a timer finds those. Unref'd, so the timer never keeps a process alive on its own.
   */
  protected startBullSchedulerCheck(): void {
    if (!this.bullQueue || !this.bullScheduledJobs.size || !(this.bullSchedulerCheckIntervalMs > 0)) {
      return;
    }
    this.bullSchedulerCheckTimer = setInterval(this.onBullQueueReady, this.bullSchedulerCheckIntervalMs);
    this.bullSchedulerCheckTimer.unref?.();
  }

  /**
   * Stop the scheduler check before the queue closes, so neither the timer nor a reconnect touches a closed queue
   */
  protected stopBullSchedulerCheck(): void {
    if (this.bullSchedulerCheckTimer) {
      clearInterval(this.bullSchedulerCheckTimer);
      this.bullSchedulerCheckTimer = undefined;
    }
    this.bullQueueConnection?.off?.('ready', this.onBullQueueReady);
    this.bullQueueConnection = undefined;
    this.bullScheduledJobs.clear();
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
    this.bullWorker
      .run()
      .catch((e: unknown) => cronLogger.error(`BullMQ cron worker stopped: ${errorMessage(e)}`, errorStack(e)));
  }

  /**
   * Debug log for a tick that another replica has already claimed
   */
  protected logSkippedTick(leaseKey: string): void {
    if (this.config.log) {
      cronLogger.debug(`CronJob tick ${leaseKey} skipped, lease held by another replica`);
    }
  }

  /**
   * Register a job as BullMQ job scheduler
   */
  protected async registerBullJob(name: string, config: CronJobConfigWithTimeZone): Promise<void> {
    // This version runs the job through BullMQ, so a removal marker an earlier configuration left no longer applies.
    const removedKey = this.bullSchedulerRemovedKey(name);
    if (removedKey) {
      await this.getRedisClient()?.del(removedKey);
    }
    await this.upsertBullScheduler(name, config);

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
      this.schedulerRegistry.addCronJob(name, this.createBullRegistryEntry(name, config));
    }

    if (this.config.log) {
      cronLogger.log(`CronJob ${name} initialized with "${config.cronTime}" (BullMQ scheduler)`);
    }
  }

  /**
   * Write the job's schedule into Redis — at bootstrap and when restoreBullSchedulers() finds it missing
   */
  protected upsertBullScheduler(name: string, config: CronJobConfigWithTimeZone): Promise<unknown> {
    return this.bullQueue.upsertJobScheduler(
      name,
      { pattern: config.cronTime as string, tz: config.timeZone ?? undefined },
      { name, opts: this.bullJobOptions },
    );
  }

  /**
   * Register a job as local cron timer
   */
  protected registerLocalJob(name: string, config: CronJobConfigWithTimeZone, distributed: boolean): void {
    // Filled after construction; runOnInit fires DURING construction, where the fire time is simply "now"
    const ref: { job?: CronJob } = {};
    /**
     * The schedule instant the next scheduled fire belongs to, read when the job is armed and after every scheduled
     * fire. cron's lastDate() is NOT that instant: cron 4 sets it to the moment its timer fired, so two replicas whose
     * timers fire on either side of a second boundary computed different lease keys and both ran the tick (DEV-3896).
     */
    let scheduledFor: number | undefined;
    /** lastDate() as of the last scheduled fire, to tell the next scheduled fire from a manual one */
    let lastFired: number | undefined;

    const job = new CronJob(
      config.cronTime,
      async () => {
        if (distributed) {
          // The runOnInit fire happens DURING construction, so `ref.job` is not assigned
          // yet — that absence is exactly how the startup run identifies itself. It takes
          // the fleet-wide init lease, because "startup" is not an instant the replicas
          // agree on; a scheduled tick takes a lease keyed on the schedule instant, which
          // every replica computes identically.
          if (!ref.job) {
            this.runInitTick(name);
            return;
          }
          // cron advances lastDate() only when its timer fires, never before the instant; a manual fireOnTick() (the
          // Hub's "Run now") leaves it as it was. Keyed on an instant, a manual run would take a lease another replica
          // may already hold (the operator's run silently skipped) or the next tick's (that tick skipped everywhere),
          // so it gets its own key.
          const fired = ref.job.lastDate()?.getTime();
          if (fired === undefined || fired === lastFired || scheduledFor === undefined || fired < scheduledFor) {
            await this.runDistributedTick(name, 'manual');
            return;
          }
          lastFired = fired;
          const instant = this.currentScheduledInstant(ref.job, scheduledFor, fired);
          scheduledFor = this.nextScheduledInstant(ref.job);
          await this.runDistributedTick(name, new Date(instant));
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
    scheduledFor = this.nextScheduledInstant(job);
    this.schedulerRegistry.addCronJob(name, job);
    if (this.config.log && this.schedulerRegistry.getCronJob(name)) {
      cronLogger.log(`CronJob ${name} initialized with "${config.cronTime}"`);
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
      cronLogger.error(`CronJob ${name} failed on its startup run: ${errorMessage(e)}`, errorStack(e));
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
      cronLogger.warn(`CronJob tick for "${name}" dropped — no registered config`);
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

    let lease: false | undefined | { release: () => Promise<void> };
    try {
      // runParallel above is per process. A job that must not run twice at once holds a lease for the length of the
      // run, so a second replica skips its next tick instead of starting it in parallel (DEV-3896).
      if (this.runsExclusively(config)) {
        lease = await this.acquireRunningLease(name);
        if (lease === false) {
          this.logSkippedTick(`${name}:running`);
          return;
        }
      }

      // Execute the job and wait until job process is done
      await this[name]();
    } catch (e) {
      if (config.throwException) {
        throw e;
      } else {
        cronLogger.error(`CronJob ${name} failed: ${errorMessage(e)}`, errorStack(e));
      }
    } finally {
      // Remove job from running list
      this.runningJobs[name] = this.runningJobs[name].filter((item) => item !== date);
      if (lease) {
        await lease.release();
      }
    }
  }

  /**
   * Whether a job may run only once at a time across all replicas: a distributed job with `runParallel: false` (or
   * `1`). A larger `runParallel` stays a per-process limit.
   */
  protected runsExclusively(config: CronJobConfigWithTimeZone): boolean {
    return config.distributed !== false && (!config.runParallel || config.runParallel === 1);
  }

  /**
   * Take the lease a running job holds, kept alive by a heartbeat until `release()`.
   *
   * Returns `false` when another replica runs the job. Without a lease backend, or when the backend fails, the job runs
   * anyway (fail open, like the tick lease): a missing lock must never stop the job.
   */
  protected async acquireRunningLease(name: string): Promise<false | { release: () => Promise<void> }> {
    const key = `${name}:running`;
    const unlocked = { release: async () => undefined };
    let store: LockStore | undefined;
    try {
      store = await this.leaseStore();
      if (!store) {
        this.warnDedupInactive();
        return unlocked;
      }
      if (!(await store.tryAcquire(key, this.leaseOwner, CRON_RUNNING_LOCK_TTL_SECONDS))) {
        return false;
      }
    } catch (e) {
      cronLogger.error(`Cron running lease for ${key} failed, running anyway: ${errorMessage(e)}`, errorStack(e));
      return unlocked;
    }

    const held = store;
    const heartbeat = setInterval(
      () => {
        held
          .renew(key, this.leaseOwner, CRON_RUNNING_LOCK_TTL_SECONDS)
          .then((renewed) => {
            if (!renewed) {
              cronLogger.warn(`Cron running lease for ${key} was lost; another replica may start the job`);
            }
          })
          .catch((e) => cronLogger.warn(`Renewing the cron running lease for ${key} failed: ${errorMessage(e)}`));
      },
      (CRON_RUNNING_LOCK_TTL_SECONDS * 1000) / 3,
    );
    heartbeat.unref?.();

    return {
      release: async () => {
        clearInterval(heartbeat);
        await held
          .release(key, this.leaseOwner)
          .catch((e) => cronLogger.warn(`Releasing the cron running lease for ${key} failed: ${errorMessage(e)}`));
      },
    };
  }

  /**
   * The store for leases with an owner: Redis when available, else the SQL lease table of the default source, else
   * `cron-locks` in MongoDB; `undefined` when there is none
   */
  protected async leaseStore(): Promise<LockStore | undefined> {
    const redis = this.getRedisClient();
    if (redis) {
      return this.redisLeaseStore(redis);
    }
    const sqlLocks = await defaultSqlLockStore('cron');
    if (sqlLocks) {
      return sqlLocks;
    }
    const connection = this.getConnection();
    if (!connection) {
      return undefined;
    }
    await this.ensureLeaseIndex(connection);
    return cronMongoLocks(connection.db.collection(CRON_LOCK_COLLECTION));
  }

  /** Leases in Redis under `<keyPrefix>:cron-lock:<key>`, renewed and released only by their owner */
  protected redisLeaseStore(redis: Redis): LockStore {
    const redisKey = (key: string) => this.getRedisService().key('cron-lock', key);
    return {
      release: async (key, owner) => (await redis.eval(REDIS_RELEASE_SCRIPT, 1, redisKey(key), owner)) === 1,
      renew: async (key, owner, ttlSeconds) =>
        (await redis.eval(REDIS_RENEW_SCRIPT, 1, redisKey(key), owner, ttlSeconds * 1000)) === 1,
      tryAcquire: async (key, owner, ttlSeconds) =>
        (await redis.set(redisKey(key), owner, 'EX', ttlSeconds, 'NX')) === 'OK',
    };
  }

  /**
   * The instant a scheduled fire belongs to: the remembered instant, moved forward to the last one at or before the
   * fire. It stays as remembered on every regular fire; it lags only when the job did not fire for a while (stopped
   * in the Hub and started again), and keyed on that old instant the first tick after a restart would run next to
   * the replica that runs the current one. Not moved for a `utcOffset` job or a one-shot date, whose schedule this
   * cannot step through.
   */
  protected currentScheduledInstant(job: CronJob, remembered: number, fired: number): number {
    const cronTime = job.cronTime;
    if (cronTime.utcOffset !== undefined || cronTime.realDate) {
      return remembered;
    }
    let instant = remembered;
    try {
      // Bounded: a job stopped for a long time on a per-second schedule must not keep the tick busy
      for (let step = 0; step < 10_000; step++) {
        const next = cronTime.getNextDateFrom(new Date(instant), cronTime.timeZone).toMillis();
        if (next > fired) {
          break;
        }
        instant = next;
      }
    } catch {
      // cron could not step the schedule: keep what is known
    }
    return instant;
  }

  /** The next instant the job's schedule fires at, in ms; `undefined` when cron cannot say (a past one-shot date) */
  protected nextScheduledInstant(job: CronJob): number | undefined {
    try {
      return job.nextDate().toMillis();
    } catch {
      return undefined;
    }
  }

  /**
   * Say once at startup which jobs run on every replica because no redis is configured and they did not choose with
   * `distributed`. Info, not a warning: most projects run one replica, where this is right (DEV-3896).
   */
  protected logLocalJobsHint(names: string[]): void {
    if (!names.length || !this.config.log) {
      return;
    }
    cronLogger.log(
      `CronJobs ${names.join(', ')} run on every replica: no redis is configured. With more than one replica, ` +
        'configure redis, or set distributed: true to take a lease in MongoDB or the SQL default source.',
    );
  }

  /**
   * Warn once that cron deduplication is not active
   */
  protected warnDedupInactive(): void {
    if (this.dedupWarned) {
      return;
    }
    this.dedupWarned = true;
    cronLogger.warn(
      'Cron job deduplication is inactive: neither a Redis service nor a Mongoose connection was passed to ' +
        'CoreCronJobs. Every replica runs every tick.',
    );
  }
}
