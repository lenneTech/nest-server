import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';

import { TenantRole } from './core-tenant.enums';

/**
 * Metadata key for tenant roles requirement.
 */
export const TENANT_ROLES_KEY = 'tenantRoles';

/**
 * Method decorator that sets the required tenant role for the endpoint.
 * When present, the CoreTenantGuard enforces:
 * - X-Tenant-Id header must be provided
 * - User must be an active member of the tenant
 * - User's tenant role must meet the minimum required level
 *
 * Role hierarchy: OWNER > ADMIN > MEMBER
 *
 * @example
 * ```typescript
 * @TenantRoles(TenantRole.ADMIN)
 * async updateProject(@CurrentTenant() tenantId: string) { ... }
 *
 * @TenantRoles(TenantRole.MEMBER)
 * async listProjects(@CurrentTenant() tenantId: string) { ... }
 * ```
 */
export const TenantRoles = (...roles: TenantRole[]) => SetMetadata(TENANT_ROLES_KEY, roles);

/**
 * Parameter decorator that extracts the validated tenant ID from the current request.
 * Returns `undefined` if no tenant header is set or route is not protected by @TenantRoles().
 *
 * @example
 * ```typescript
 * @Get('projects')
 * async listProjects(@CurrentTenant() tenantId: string | undefined) {
 *   // tenantId comes from X-Tenant-Id header, validated by guard
 * }
 * ```
 */
export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  if (ctx.getType<GqlContextType>() === 'graphql') {
    const gqlContext = GqlExecutionContext.create(ctx);
    return gqlContext.getContext().req?.activeTenantId;
  }
  return ctx.switchToHttp().getRequest()?.activeTenantId;
});
