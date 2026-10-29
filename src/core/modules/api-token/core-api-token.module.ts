import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule, Type } from '@nestjs/common';
import { SchemaFactory } from '../../common/persistence/mongo/mongoose-compat.js';

import { CorePersistenceModule } from '../../common/persistence/core-persistence.module.js';
import { API_TOKEN_MODEL_TOKEN } from './core-api-token.constants.js';
import { CoreApiTokenMiddleware } from './core-api-token.middleware.js';
import { CoreApiTokenModel } from './core-api-token.model.js';
import { CoreApiTokenService } from './core-api-token.service.js';

/**
 * Options for `CoreApiTokenModule.forRoot()`.
 */
export interface CoreApiTokenModuleOptions {
  /** Custom token model (must extend CoreApiTokenModel) — e.g. to bind a token to project data */
  model?: Type<CoreApiTokenModel>;
  /** Custom service (must extend CoreApiTokenService) */
  service?: Type<CoreApiTokenService>;
}

/**
 * API tokens (`apiTokens` config): USER tokens and — with multi-tenancy — TENANT tokens.
 *
 * Registered automatically by `CoreModule.forRoot()` when `apiTokens` is configured. Provides the
 * token model, `CoreApiTokenService` (authentication + management) and `CoreApiTokenMiddleware` on all
 * routes. Route access is enforced by the framework's guards (RolesGuard / BetterAuthRolesGuard, plus
 * CoreTenantGuard with multi-tenancy) via `@ApiTokenScopes()`.
 */
@Global()
@Module({})
export class CoreApiTokenModule implements NestModule {
  static forRoot(options: CoreApiTokenModuleOptions = {}): DynamicModule {
    const schema = SchemaFactory.createForClass(options.model || CoreApiTokenModel);
    // Compound indexes for the two management listings; single-field indexes live on the properties.
    schema.index({ kind: 1, tenant: 1 });
    schema.index({ kind: 1, user: 1 });

    return {
      exports: [CoreApiTokenService],
      global: true,
      // Database-neutral registration: the token model follows `database` like every other model
      imports: [CorePersistenceModule.forFeature([{ name: API_TOKEN_MODEL_TOKEN, schema }])],
      module: CoreApiTokenModule,
      providers: [{ provide: CoreApiTokenService, useClass: options.service || CoreApiTokenService }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CoreApiTokenMiddleware).forRoutes('*');
  }
}
