import { CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { CronJobConfig } from '../interfaces/cron-job-config.interface';
import { Falsy } from '../types/falsy.type';

/**
 * Cron jobs service to extend
 */
export abstract class CoreCronJobs {
  /**
   * Config for cron jobs
   */
  config: {
    [key: string]: any;
    log: boolean;
  };

  // ===================================================================================================================
  // Initializations
  // ===================================================================================================================

  /**
   * Integrate services and init chron jobs
   */
  protected constructor(
    protected schedulerRegistry: SchedulerRegistry,
    protected cronJobs: Record<string, CronExpression | string | Date | Falsy | CronJobConfig>,
    options?: { log?: boolean }
  ) {
    this.config = {
      log: true,
      ...options,
    };
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
      if (!CronExpressionOrConfig) {
        continue;
      }

      // Prepare config
      let config: CronExpression | string | Date | Falsy | CronJobConfig = CronExpressionOrConfig;
      if (typeof config === 'string' || config instanceof Date) {
        config = {
          cronTime: config,
        };
      }

      // Set defaults
      config = {
        timeZone: 'Europe/Berlin',
        runOnInit: true,
        ...config,
      };

      // Check if cron job should be activated
      if (!config?.cronTime) {
        continue;
      }

      // check if cron job exists
      if (!this[name]) {
        if (this.config.log) {
          console.log('Missing cron job function ' + name);
        }
        continue;
      }

      // Init cron job
      const job = new CronJob(
        config.cronTime,
        () => {
          this[name]();
        },
        null,
        true,
        config.timeZone,
        config.context,
        config.runOnInit,
        config.utcOffset,
        config.unrefTimeout
      );
      this.schedulerRegistry.addCronJob(name, job);
      if (this.config.log && this.schedulerRegistry.getCronJob(name)) {
        console.log(`CronJob ${name} initialized with "${config.cronTime}"`);
      }
    }
  }
}
