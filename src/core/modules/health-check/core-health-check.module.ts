import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { HealthIndicatorService, MongooseHealthIndicator, TerminusModule } from '@nestjs/terminus';

import type { IServerOptions } from '../../common/interfaces/server-options.interface.js';
import { getConnectionToken } from '../../common/persistence/mongo/mongoose-compat.js';

import { CoreHealthCheckReadinessController } from './core-health-check-readiness.controller.js';
import { CoreHealthCheckController } from './core-health-check.controller.js';
import { resolveHealthCheckReadiness } from './core-health-check.helpers.js';
import { CoreHealthCheckResolver } from './core-health-check.resolver.js';
import { CoreHealthCheckService } from './core-health-check.service.js';

/** Options of {@link CoreHealthCheckModule.forRoot} — what `CoreModule.forRoot()` passes on */
export interface ICoreHealthCheckModuleOptions {
  /** `healthCheck.readiness`: registers `GET /health-check/ready` when set (boolean shorthand) */
  readiness?: NonNullable<IServerOptions['healthCheck']>['readiness'];

  /** Replaces `CoreHealthCheckReadinessController`; must extend it */
  readinessController?: Type<any>;

  /** Replaces `CoreHealthCheckService`; must extend it — the way to add checks (`additionalHealthIndicators()`) */
  service?: Type<CoreHealthCheckService>;
}

/**
 * This is a module that imports the TerminusModule and includes a HealthController.
 * Inspired by https://mobileappcircular.com/marketplace-backend-creating-a-health-check-endpoint-in-nestjs-app-using-terminus-25727e96c7d2
 *
 * Imported as it is, the module registers the liveness check (`GET /health-check`, the `healthCheck` query) exactly as
 * before 12.11.0. `forRoot()` adds what the configuration and the overrides ask for: the readiness endpoint and a
 * project's subclass of `CoreHealthCheckService`.
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
export class CoreHealthCheckModule {
  /**
   * The module with the readiness endpoint and the service override (12.11.0). A dynamic module EXTENDS the static
   * metadata above, so only what is not there is added: the readiness controller (only with `readiness`), and a project
   * service registered under its own class and — replacing the core one — under `CoreHealthCheckService`, which the
   * controllers and the resolver inject.
   */
  static forRoot(options: ICoreHealthCheckModuleOptions = {}): DynamicModule {
    const readiness = resolveHealthCheckReadiness({ readiness: options.readiness });
    const controllers = readiness.enabled ? [options.readinessController || CoreHealthCheckReadinessController] : [];
    const providers =
      options.service && options.service !== CoreHealthCheckService
        ? [options.service, { provide: CoreHealthCheckService, useExisting: options.service }]
        : [];
    return { controllers, module: CoreHealthCheckModule, providers };
  }
}
