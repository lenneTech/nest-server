import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { ConfigService } from '../../../core/common/services/config.service.js';
import { CoreCronJobs } from '../../../core/common/services/core-cron-jobs.service.js';

@Injectable()
export class CronJobs extends CoreCronJobs {
  protected readonly logger = new Logger(CronJobs.name);

  // ===================================================================================================================
  // Initializations
  // ===================================================================================================================

  /**
   * Init cron jobs
   */
  constructor(
    protected override schedulerRegistry: SchedulerRegistry,
    protected configService: ConfigService,
  ) {
    super(schedulerRegistry, configService.config.cronJobs, { log: true });
  }

  // ===================================================================================================================
  // Cron jobs
  // ===================================================================================================================

  protected sayHello() {
    this.logger.log('Hello :)');
  }
}
