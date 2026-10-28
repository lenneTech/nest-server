import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { HealthIndicatorService, MongooseHealthIndicator, TerminusModule } from '@nestjs/terminus';

import { getConnectionToken } from '../../common/persistence/mongo/mongoose-compat.js';

import { CoreHealthCheckController } from './core-health-check.controller.js';
import { CoreHealthCheckResolver } from './core-health-check.resolver.js';
import { CoreHealthCheckService } from './core-health-check.service.js';

/**
 * This is a module that imports the TerminusModule and includes a HealthController.
 * Inspired by https://mobileappcircular.com/marketplace-backend-creating-a-health-check-endpoint-in-nestjs-app-using-terminus-25727e96c7d2
 */
@Module({
  controllers: [CoreHealthCheckController],
  imports: [TerminusModule],
  providers: [
    CoreHealthCheckService,
    CoreHealthCheckResolver,
    {
      inject: [ModuleRef, HealthIndicatorService, { optional: true, token: getConnectionToken() }],
      provide: MongooseHealthIndicator,
      // Terminus' indicator requires Mongoose as it is constructed. Without a MongoDB connection (a project on
      // PostgreSQL alone) there is nothing for it to ping, and no Mongoose to require: the service skips the ping
      useFactory: (moduleRef: ModuleRef, indicators: HealthIndicatorService, connection?: unknown) =>
        connection ? new MongooseHealthIndicator(moduleRef, indicators) : null,
    },
  ],
})
export class CoreHealthCheckModule {}
