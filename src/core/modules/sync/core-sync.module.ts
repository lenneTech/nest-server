import { DynamicModule, Module, Type } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule } from '@nestjs/core';

import { CorePersistenceModule } from '../../common/persistence/core-persistence.module.js';
import { SYNC_DEFAULTS, SYNC_MUTATION_MODEL, SYNC_STATE_MODEL } from './core-sync.constants.js';
import { CoreSyncController } from './core-sync.controller.js';
import { CoreSyncHintService } from './core-sync-hints.service.js';
import { SyncMutationSchema, SyncStateSchema } from './core-sync-infrastructure.models.js';
import { CoreSyncResolver } from './core-sync.resolver.js';
import { CoreSyncService } from './core-sync.service.js';

/** Options for `CoreSyncModule.forRoot()` */
export interface CoreSyncModuleOptions {
  /** Custom controller (must extend CoreSyncController) */
  controller?: Type<CoreSyncController>;
  /**
   * Register the GraphQL hint subscription `syncHint` — `false` where GraphQL is disabled or `sync.hints.graphql` /
   * `sync.hints` is `false`
   * @default true
   */
  graphQlHints?: boolean;
  /** Route prefix (`sync.path`) @default 'sync' */
  path?: string;
  /** Custom resolver of the hint subscription (must extend CoreSyncResolver) */
  resolver?: Type<CoreSyncResolver>;
  /** Custom service (must extend CoreSyncService) */
  service?: Type<CoreSyncService>;
}

/**
 * Offline sync (`sync` config, protocol `docs/offline-sync-protocol.md`).
 *
 * Registered automatically by `CoreModule.forRoot()` when `sync` is configured. Provides the sync routes, the change
 * hints (SSE and, with GraphQL, the `syncHint` subscription), the service, the tombstone purge and the module's two
 * infrastructure models (mutations; epochs and horizons), which follow `database` like every
 * other model. Which models are offered is decided by the project: a CrudService with `@SyncService()` whose model is
 * declared with `@PersistedModel({ sync })`.
 */
@Module({})
export class CoreSyncModule {
  static forRoot(options: CoreSyncModuleOptions = {}): DynamicModule {
    const controller = options.controller ?? CoreSyncController;
    // The configured prefix wins over the class's declaration, as for the TUS routes
    Reflect.defineMetadata(PATH_METADATA, options.path || SYNC_DEFAULTS.path, controller);
    return {
      controllers: [controller],
      exports: [CoreSyncHintService, CoreSyncService],
      imports: [
        DiscoveryModule,
        CorePersistenceModule.forFeature([
          { name: SYNC_MUTATION_MODEL, schema: SyncMutationSchema },
          { name: SYNC_STATE_MODEL, schema: SyncStateSchema },
        ]),
      ],
      module: CoreSyncModule,
      providers: [
        CoreSyncHintService,
        options.service ? { provide: CoreSyncService, useClass: options.service } : CoreSyncService,
        ...(options.graphQlHints === false ? [] : [options.resolver ?? CoreSyncResolver]),
      ],
    };
  }
}
