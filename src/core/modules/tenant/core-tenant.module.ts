import { CanActivate, DynamicModule, Global, Module, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule, SchemaFactory, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { roleScopeRegistry } from './core-role-scope.registry';
import { CoreTenantMemberModel } from './core-tenant-member.model';
import { TENANT_MEMBER_MODEL_TOKEN } from './core-tenant.enums';
import { assertRoleVocabularyIsCoherent, configRoleScopeSource } from './core-tenant.helpers';
import { CoreTenantGuard } from './core-tenant.guard';
import { CoreTenantService } from './core-tenant.service';

/**
 * Options for CoreTenantModule.forRoot().
 *
 * Projects using auto-registration via `multiTenancy: {}` get default implementations.
 * For custom model/guard/service, use `CoreTenantModule.forRoot({ ... })` directly
 * in your ServerModule instead of auto-registration.
 */
export interface CoreTenantModuleOptions {
  /** Custom TenantMember model class (must extend CoreTenantMemberModel) */
  memberModel?: Type<CoreTenantMemberModel>;
  /** Custom guard class (must implement CanActivate) */
  guard?: Type<CanActivate>;
  /** Custom service class (must extend CoreTenantService) */
  service?: Type<CoreTenantService>;
  /**
   * Mongoose model name for the membership collection.
   * Defaults to 'TenantMember'. When changed, an alias is created so that
   * @InjectModel('TenantMember') continues to work in guard and service.
   * @default 'TenantMember'
   */
  modelName?: string;
}

/**
 * Core tenant module for multi-tenancy support.
 *
 * Provides:
 * - TenantMember model (user <-> tenant membership with roles)
 * - CoreTenantGuard (APP_GUARD for X-Tenant-Id header validation)
 * - CoreTenantService (membership CRUD operations)
 *
 * Projects can extend via the Module Inheritance Pattern by passing custom
 * model, guard, or service classes to forRoot().
 *
 * @example
 * ```typescript
 * // Auto-registration via CoreModule config
 * CoreModule.forRoot({ multiTenancy: {} })
 *
 * // Manual registration with custom service
 * CoreTenantModule.forRoot({ service: CustomTenantService })
 *
 * // Custom model name (config.multiTenancy.membershipModel)
 * CoreTenantModule.forRoot({ modelName: 'OrgMember' })
 * ```
 */
@Global()
@Module({})
export class CoreTenantModule {
  static forRoot(options: CoreTenantModuleOptions = {}): DynamicModule {
    // Teach the role-scope registry which roles are global and which are tenant-scoped, then
    // refuse to boot on a vocabulary that cannot be enforced coherently (a tenant role named after
    // a framework role, or one role declared in both scopes). An ambiguous authorization rule is
    // worse than a server that does not start, so this throws rather than warns.
    //
    // Registration is idempotent: forRoot() may run more than once across test module fixtures.
    roleScopeRegistry.clear();
    roleScopeRegistry.register(configRoleScopeSource);
    assertRoleVocabularyIsCoherent();

    const MemberModel = options.memberModel || CoreTenantMemberModel;
    const Guard = options.guard || CoreTenantGuard;
    const Service = options.service || CoreTenantService;
    const modelName = options.modelName || TENANT_MEMBER_MODEL_TOKEN;

    const memberSchema = SchemaFactory.createForClass(MemberModel);

    // Compound unique index: one membership per user per tenant
    memberSchema.index({ user: 1, tenant: 1 }, { unique: true });
    // Compound index for per-request membership lookups (index-covered query)
    memberSchema.index({ user: 1, tenant: 1, status: 1 });

    const providers: any[] = [
      {
        provide: CoreTenantService,
        useClass: Service,
      },
      // Registered under its OWN token first, then aliased to APP_GUARD — the pattern
      // CoreAuthModule uses for RolesGuard. A bare `{ provide: APP_GUARD, useClass: Guard }`
      // makes Nest mint an internal token for the instance, so `@Optional() CoreTenantGuard`
      // in CoreTenantService resolves to undefined and every invalidateUser()/invalidateAll()
      // — including the cross-replica Redis broadcast — silently did nothing.
      Guard,
      ...(Guard === CoreTenantGuard ? [] : [{ provide: CoreTenantGuard, useExisting: Guard }]),
      { provide: APP_GUARD, useExisting: Guard },
    ];

    // When a custom model name is used, alias the default injection token to the custom model.
    // This allows @InjectModel(TENANT_MEMBER_MODEL_TOKEN) in guard/service to continue working.
    if (modelName !== TENANT_MEMBER_MODEL_TOKEN) {
      providers.push({
        provide: getModelToken(TENANT_MEMBER_MODEL_TOKEN),
        useFactory: (model: Model<any>) => model,
        inject: [getModelToken(modelName)],
      });
    }

    return {
      exports: [CoreTenantService],
      global: true,
      imports: [MongooseModule.forFeature([{ name: modelName, schema: memberSchema }])],
      module: CoreTenantModule,
      providers,
    };
  }
}
