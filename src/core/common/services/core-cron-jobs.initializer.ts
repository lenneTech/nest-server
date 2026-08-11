import { Injectable, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
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
export class CoreCronJobsInitializer implements OnApplicationShutdown, OnModuleInit {
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

  /**
   * Drop the module-global references again.
   *
   * The registry outlives the application that filled it, so without this a closed app leaves its
   * (now closed) Mongoose connection and Redis service behind for whatever app starts next in the
   * same process — a test suite, or any host that creates more than one application.
   */
  onApplicationShutdown(): void {
    setCronJobsInfrastructure({});
  }
}
