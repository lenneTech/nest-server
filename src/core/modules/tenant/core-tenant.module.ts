import { DynamicModule, Global, Module, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule, SchemaFactory } from '@nestjs/mongoose';

import { CoreTenantMemberModel } from './core-tenant-member.model';
import { CoreTenantGuard } from './core-tenant.guard';
import { CoreTenantService } from './core-tenant.service';

/**
 * Options for CoreTenantModule.forRoot()
 */
export interface CoreTenantModuleOptions {
  /** Custom TenantMember model class (must extend CoreTenantMemberModel) */
  memberModel?: Type<any>;
  /** Custom guard class (must implement CanActivate) */
  guard?: Type<any>;
  /** Custom service class (must extend CoreTenantService) */
  service?: Type<any>;
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
 * ```
 */
@Global()
@Module({})
export class CoreTenantModule {
  static forRoot(options: CoreTenantModuleOptions = {}): DynamicModule {
    const MemberModel = options.memberModel || CoreTenantMemberModel;
    const Guard = options.guard || CoreTenantGuard;
    const Service = options.service || CoreTenantService;

    const memberSchema = SchemaFactory.createForClass(MemberModel);

    // Compound unique index: one membership per user per tenant
    memberSchema.index({ user: 1, tenant: 1 }, { unique: true });

    return {
      exports: [Service],
      global: true,
      imports: [MongooseModule.forFeature([{ name: 'TenantMember', schema: memberSchema }])],
      module: CoreTenantModule,
      providers: [
        {
          provide: CoreTenantService,
          useClass: Service,
        },
        {
          provide: APP_GUARD,
          useClass: Guard,
        },
      ],
    };
  }
}
