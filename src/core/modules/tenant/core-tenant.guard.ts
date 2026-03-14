import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { RoleEnum } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { CoreTenantMemberModel } from './core-tenant-member.model';
import { SKIP_TENANT_CHECK_KEY } from './core-tenant.decorators';
import { TENANT_MEMBER_MODEL_TOKEN, TenantMemberStatus } from './core-tenant.enums';
import {
  checkRoleAccess,
  getMinRequiredLevel,
  getRoleHierarchy,
  isSystemRole,
  mergeRolesMetadata,
} from './core-tenant.helpers';

/**
 * Global guard for multi-tenancy with defense-in-depth security.
 *
 * Only registered as APP_GUARD when multiTenancy is active.
 * Runs after auth guards to validate tenant membership and role access.
 *
 * This guard is responsible for ALL non-system role checks when multiTenancy is active.
 * RolesGuard passes through non-system roles to this guard.
 *
 * Security model:
 * - Guard level: Membership validation, admin bypass, role checks (hierarchy + normal)
 * - Plugin level: Safety net — ForbiddenException when tenantId-schema accessed without context
 *
 * Role check semantics:
 * - Hierarchy roles (in roleHierarchy config): level comparison — higher includes lower
 * - Normal roles (not in roleHierarchy): exact match — no compensation by higher role
 * - Tenant context (header present): checks against membership.role only (user.roles ignored)
 * - No tenant context: checks against user.roles
 *
 * Flow:
 * 1. Config check: multiTenancy enabled?
 * 2. Parse header (X-Tenant-Id, max 128 chars, trimmed)
 * 3. @SkipTenantCheck → role check against user.roles, no tenant context
 * 4. Read @Roles() metadata, filter out system roles
 *
 * HEADER PRESENT:
 *   - System ADMIN (adminBypass: true) → set req.tenantId + isAdminBypass
 *   - No user → 403 "Authentication required for tenant access"
 *   - Authenticated non-admin user:
 *     - Active member → checkRoleAccess against membership.role → set req.tenantId + tenantRole
 *     - Not active member → ALWAYS 403
 *
 * NO HEADER:
 *   - System ADMIN → set isAdminBypass (sees all data)
 *   - Authenticated + checkable roles → checkRoleAccess against user.roles
 *     → resolveUserTenantIds with minLevel filter
 *   - Authenticated + no checkable roles → resolveUserTenantIds (all memberships)
 *   - No user + no checkable roles → pass (plugin safety net catches tenantId-schema access)
 *   - No user + checkable roles → 403 "Authentication required"
 */
@Injectable()
export class CoreTenantGuard implements CanActivate {
  private readonly logger = new Logger(CoreTenantGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @InjectModel(TENANT_MEMBER_MODEL_TOKEN) private readonly memberModel: Model<CoreTenantMemberModel>,
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

    // Parse tenant header
    const headerName = (config.headerName ?? 'x-tenant-id').toLowerCase();
    const rawHeader = request.headers?.[headerName] as string | undefined;
    const headerTenantId =
      rawHeader && typeof rawHeader === 'string' && rawHeader.length <= 128 ? rawHeader.trim() : undefined;

    // Read @Roles() metadata and filter to non-system roles
    const rolesMetadata = this.reflector.getAll<string[][]>('roles', [context.getHandler(), context.getClass()]);
    const roles = mergeRolesMetadata(rolesMetadata);
    const checkableRoles = roles.filter((r) => !isSystemRole(r));
    const minRequiredLevel = getMinRequiredLevel(checkableRoles);

    const user = request.user;
    const adminBypass = config.adminBypass !== false;
    const isAdmin = adminBypass && user?.roles?.includes(RoleEnum.ADMIN);

    // @SkipTenantCheck → no tenant context, but role check against user.roles
    const skipTenantCheck = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipTenantCheck) {
      if (checkableRoles.length > 0 && user) {
        if (!isAdmin && !checkRoleAccess(checkableRoles, user.roles, undefined)) {
          throw new ForbiddenException('Insufficient role');
        }
      }
      return true;
    }

    // === HEADER PRESENT ===
    if (headerTenantId) {
      // Admin bypass: set req.tenantId so plugin filters (read by RequestContextMiddleware
      // lazy getter → context.tenantId, also consumed by @CurrentTenant() via RequestContext)
      if (isAdmin) {
        request.tenantId = headerTenantId;
        request.isAdminBypass = true;
        const requiredRole = checkableRoles.length > 0 ? checkableRoles.join(',') : 'none';
        this.logger.log(
          `Admin bypass: user ${user.id} accessing tenant ${headerTenantId} (required: ${requiredRole})`,
        );
        return true;
      }

      // No user + header → 403 (tenant access requires authentication)
      if (!user) {
        throw new ForbiddenException('Authentication required for tenant access');
      }

      // Authenticated non-admin user: MUST be active member
      const membership = await this.memberModel
        .findOne({
          status: TenantMemberStatus.ACTIVE,
          tenant: headerTenantId,
          user: user.id,
        })
        .lean()
        .exec();

      if (!membership) {
        throw new ForbiddenException('Not a member of this tenant');
      }

      const memberRole = membership.role as string;

      // Check role access if roles are required (hierarchy + normal, against membership.role)
      if (checkableRoles.length > 0) {
        if (!checkRoleAccess(checkableRoles, undefined, memberRole)) {
          throw new ForbiddenException('Insufficient tenant role');
        }
      }

      // Set validated tenant context on request (consumed by RequestContextMiddleware
      // lazy getter → context.tenantId / context.tenantRole, and by @CurrentTenant() via RequestContext)
      request.tenantId = headerTenantId;
      request.tenantRole = memberRole;
      return true;
    }

    // === NO HEADER ===

    // Admin without header → sees all data
    if (isAdmin) {
      request.isAdminBypass = true;
      return true;
    }

    // Checkable roles present
    if (checkableRoles.length > 0) {
      // No user + roles required → 403
      if (!user) {
        throw new ForbiddenException('Authentication required');
      }

      // Check role access against user.roles (hierarchy: level comparison, normal: exact match)
      if (!checkRoleAccess(checkableRoles, user.roles, undefined)) {
        throw new ForbiddenException('Insufficient role');
      }

      // Resolve tenant IDs filtered by minimum required hierarchy level
      await this.resolveUserTenantIds(request, minRequiredLevel);
      return true;
    }

    // Authenticated user without header and no checkable roles: resolve their tenant memberships
    // so the plugin can filter by { tenantId: { $in: tenantIds } }
    if (user) {
      await this.resolveUserTenantIds(request);
    }

    return true;
  }

  /**
   * Look up all active tenant memberships for the user and store them on the request.
   * This allows the tenant plugin to filter by { tenantId: { $in: tenantIds } }
   * when no specific tenant header is set.
   *
   * @param minLevel - When set, only include memberships where role level >= minLevel
   */
  private async resolveUserTenantIds(request: any, minLevel?: number): Promise<void> {
    // Skip if already resolved (request-scoped caching)
    if (request.tenantIds) {
      return;
    }

    const memberships = await this.memberModel
      .find({
        status: TenantMemberStatus.ACTIVE,
        user: request.user.id,
      })
      .select('tenant role')
      .lean()
      .exec();

    if (minLevel !== undefined) {
      const hierarchy = getRoleHierarchy();
      request.tenantIds = memberships
        .filter((m) => {
          const level = hierarchy[m.role as string] ?? 0;
          return level >= minLevel;
        })
        .map((m) => m.tenant);
    } else {
      request.tenantIds = memberships.map((m) => m.tenant);
    }
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
