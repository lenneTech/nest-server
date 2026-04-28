import { DynamicModule, Global, Module, Type } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';

import { CoreSyncController } from './core-sync.controller';
import { CoreSyncResolver } from './core-sync.resolver';
import { CoreSyncService, SYNC_MODELS, SYNC_PUB_SUB } from './core-sync.service';
import { SyncRateLimitGuard } from './sync-rate-limit.guard';

export interface CoreSyncModuleOptions {
  controller?: Type<any>;
  resolver?: Type<any>;
  service?: Type<CoreSyncService>;
  rateLimitGuard?: Type<any>;
  pubSub?: any;
  models?: any[];
  /** When true (default for non-test environments), registers the GraphQL resolver. */
  enableHint?: boolean;
  /** When true (default), registers the REST controller. */
  enableRest?: boolean;
}

/**
 * Dynamic module that wires together the sync feature.
 *
 * Activated automatically by `CoreModule.forRoot` when `config.sync` is
 * truthy. Projects can:
 * - Override the controller/resolver/service to add custom behavior.
 * - Inject a Redis-backed PubSub for multi-instance deployments.
 * - Pre-register their models via the `models` option (instead of
 *   delegating to `IServerOptions.sync.models`).
 */
@Global()
@Module({})
export class CoreSyncModule {
  static forRoot(options: CoreSyncModuleOptions = {}): DynamicModule {
    const ServiceClass = options.service || CoreSyncService;
    const ResolverClass = options.resolver || CoreSyncResolver;
    const ControllerClass = options.controller || CoreSyncController;
    const GuardClass = options.rateLimitGuard || SyncRateLimitGuard;

    const enableRest = options.enableRest !== false;
    const enableHint = options.enableHint !== false;

    const providers: any[] = [
      {
        provide: SYNC_MODELS,
        useValue: options.models || [],
      },
      {
        provide: SYNC_PUB_SUB,
        useFactory: () => options.pubSub || new PubSub(),
      },
      ServiceClass,
      GuardClass,
    ];

    if (enableHint) {
      providers.push(ResolverClass);
    }

    return {
      controllers: enableRest ? [ControllerClass] : [],
      exports: [ServiceClass, SYNC_PUB_SUB, SYNC_MODELS],
      module: CoreSyncModule,
      providers,
    };
  }
}
