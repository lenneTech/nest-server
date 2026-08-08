import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { setCronJobsInfrastructure } from './core-cron-jobs.registry';
import { CoreRedisService } from './core-redis.service';

/**
 * Populates the cron-jobs infrastructure registry at bootstrap so that
 * CoreCronJobs subclasses get multi-replica deduplication (Redis/BullMQ or
 * Mongo lease) WITHOUT any constructor changes in consumer projects.
 *
 * Registered as a CoreModule provider; consumers never interact with it.
 */
@Injectable()
export class CoreCronJobsInitializer implements OnModuleInit {
  constructor(
    @InjectConnection() protected readonly connection: Connection,
    @Optional() protected readonly redisService?: CoreRedisService,
  ) {}

  onModuleInit(): void {
    setCronJobsInfrastructure({
      connection: this.connection,
      redisService: this.redisService?.enabled ? this.redisService : undefined,
    });
  }
}
