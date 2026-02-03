import { OnApplicationBootstrap } from '@nestjs/common';
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { CronJobConfigWithTimeZone } from '../interfaces/cron-job-config-with-time-zone.interface';
import { CronJobConfigWithUtcOffset } from '../interfaces/cron-job-config-with-utc-offset.interface';
import { Falsy } from '../types/falsy.type';

/**
 * Cron jobs service to extend
 */
export abstract class CoreCronJobs implements OnApplicationBootstrap {
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
    options?: { log?: boolean },
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
  onApplicationBootstrap() {
    if (this.config.log) {
      console.info('Init CronJobs after application bootstrap');
    }
    this.initCronJobs();
  }

  /**
   * Init cron jobs
   */
  protected initCronJobs() {
    // Get cron jobs
    if (!this.cronJobs) {
      return;
    }

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

      // Init cron job
      const job = new CronJob(
        config.cronTime,
        async () => {
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
        },
        null,
        true,
        config.timeZone,
        config.context,
        config.runOnInit,
        config.utcOffset,
        config.unrefTimeout,
      );
      this.schedulerRegistry.addCronJob(name, job);
      if (this.config.log && this.schedulerRegistry.getCronJob(name)) {
        console.info(`CronJob ${name} initialized with "${config.cronTime}"`);
      }
    }
  }
}
