import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '../../../core/common/services/config.service';
import { CoreCronJobs } from '../../../core/common/services/core-cron-jobs.service';

@Injectable()
export class CronJobs extends CoreCronJobs {
  // ===================================================================================================================
  // Initializations
  // ===================================================================================================================

  /**
   * Init cron jobs
   */
  constructor(protected override schedulerRegistry: SchedulerRegistry, protected configService: ConfigService) {
    super(schedulerRegistry, configService.config.cronJobs, { log: true });
  }

  // ===================================================================================================================
  // Cron jobs
  // ===================================================================================================================

  protected async sayHello() {
    console.info('Hello :)');
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 30000);
    });
  }
}
