import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import envConfig from '../../../config.env';
import { CoreCronJobs } from '../../../core/common/services/core-cron-jobs.service';

@Injectable()
export class CronJobs extends CoreCronJobs {
  // ===================================================================================================================
  // Initializations
  // ===================================================================================================================

  /**
   * Init cron jobs
   */
  constructor(protected schedulerRegistry: SchedulerRegistry) {
    super(schedulerRegistry, envConfig.cronJobs, { log: true });
  }

  // ===================================================================================================================
  // Cron jobs
  // ===================================================================================================================

  protected async sayHello() {
    console.log('Hello :)');
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 30000);
    });
  }
}
