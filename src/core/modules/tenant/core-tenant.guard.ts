import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { RoleEnum } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { CoreTenantMemberModel } from './core-tenant-member.model';
import { TENANT_ROLES_KEY } from './core-tenant.decorators';
import { TENANT_ROLE_HIERARCHY, TenantMemberStatus, TenantRole } from './core-tenant.enums';

/**
 * Global guard for multi-tenancy.
 *
 * Only registered as APP_GUARD when multiTenancy is active.
 * Runs after auth guards to validate tenant membership.
 *
 * Logic:
 * 1. Read X-Tenant-Id header
 * 2. No header + no @TenantRoles() → resolve user's tenantIds for plugin filtering, pass through
 * 3. No header + @TenantRoles() → 403
 * 4. Header + no user → 403
 * 5. Admin bypass (if configured) → set activeTenantId on request, pass
 * 6. Validate active membership → set activeTenantId + tenantRole on request
 * 7. Check role hierarchy against @TenantRoles() requirement
 */
@Injectable()
export class CoreTenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectModel('TenantMember') private readonly memberModel: Model<CoreTenantMemberModel>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = ConfigService.configFastButReadOnly?.multiTenancy;
    if (!config || config.enabled === false) {
      return true;
    }

    const request = this.getRequest(context);
    if (!request) {
      return true;
    }

    const headerName = (config.headerName ?? 'x-tenant-id').toLowerCase();
    const rawHeader = request.headers?.[headerName] as string | undefined;
    const tenantId =
      rawHeader && typeof rawHeader === 'string' && rawHeader.length <= 128 ? rawHeader.trim() : undefined;

    // Get @TenantRoles() metadata from handler and class
    const requiredRoles = this.reflector.getAllAndOverride<TenantRole[] | undefined>(TENANT_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @TenantRoles() decorator → no membership enforcement needed.
    // Do NOT set request.activeTenantId here — without membership validation,
    // @CurrentTenant() should return undefined on unprotected routes.
    // The tenant plugin still reads the header directly from the middleware.
    if (!requiredRoles) {
      // When no header is set but user is authenticated, resolve their tenant memberships
      // so the tenant plugin can filter by { tenantId: { $in: tenantIds } }
      if (!tenantId && request.user && !request.tenantIds) {
        await this.resolveUserTenantIds(request);
      }
      return true;
    }

    // @TenantRoles() present but no header → must provide tenant
    if (!tenantId) {
      throw new ForbiddenException('X-Tenant-Id header required');
    }

    // Header present but no authenticated user
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Authentication required for tenant access');
    }

    // Admin bypass: system admins skip membership check and get OWNER-level access.
    // Intentional escalation: admins need full tenant access for cross-tenant operations.
    const adminBypass = config.adminBypass !== false;
    if (adminBypass && user.roles?.includes(RoleEnum.ADMIN)) {
      request.activeTenantId = tenantId;
      request.tenantRole = TenantRole.OWNER;
      return true;
    }

    // Look up active membership
    const membership = await this.memberModel
      .findOne({
        status: TenantMemberStatus.ACTIVE,
        tenant: tenantId,
        user: user.id,
      })
      .lean()
      .exec();

    if (!membership) {
      throw new ForbiddenException('Not a member of this tenant');
    }

    const memberRole = membership.role as TenantRole;

    // Check role hierarchy if @TenantRoles() is set
    if (requiredRoles && requiredRoles.length > 0) {
      const memberLevel = TENANT_ROLE_HIERARCHY[memberRole] ?? 0;
      // User must meet at least one of the required roles
      const hasRequiredRole = requiredRoles.some((required) => {
        const requiredLevel = TENANT_ROLE_HIERARCHY[required] ?? 0;
        return memberLevel >= requiredLevel;
      });

      if (!hasRequiredRole) {
        throw new ForbiddenException('Insufficient tenant role');
      }
    }

    // Set tenant context on request
    request.activeTenantId = tenantId;
    request.tenantRole = memberRole;

    return true;
  }

  /**
   * Look up all active tenant memberships for the user and store them on the request.
   * This allows the tenant plugin to filter by { tenantId: { $in: tenantIds } }
   * when no specific tenant header is set.
   */
  private async resolveUserTenantIds(request: any): Promise<void> {
    const memberships = await this.memberModel
      .find({
        status: TenantMemberStatus.ACTIVE,
        user: request.user.id,
      })
      .select('tenant')
      .lean()
      .exec();

    request.tenantIds = memberships.map((m) => m.tenant);
  }

  /**
   * Extract request from GraphQL or HTTP context
   */
  private getRequest(context: ExecutionContext): any {
    if (context.getType<GqlContextType>() === 'graphql') {
      const ctx = GqlExecutionContext.create(context);
      return ctx.getContext()?.req;
    }
    try {
      return context.switchToHttp().getRequest();
    } catch {
      return null;
    }
  }
}
