import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { CoreHealthCheckController } from './core-health-check.controller';
import { CoreHealthCheckResolver } from './core-health-check.resolver';
import { CoreHealthCheckService } from './core-health-check.service';

/**
 * This is a module that imports the TerminusModule and includes a HealthController.
 * Inspired by https://mobileappcircular.com/marketplace-backend-creating-a-health-check-endpoint-in-nestjs-app-using-terminus-25727e96c7d2
 */
@Module({
  controllers: [CoreHealthCheckController],
  imports: [TerminusModule],
  providers: [CoreHealthCheckService, CoreHealthCheckResolver],
})
export class CoreHealthCheckModule {}
