import { createParamDecorator, SetMetadata } from '@nestjs/common';

import { RequestContext } from '../../common/services/request-context.service';

/**
 * Metadata key for @SkipTenantCheck() decorator.
 */
export const SKIP_TENANT_CHECK_KEY = 'skipTenantCheck';

/**
 * Method/class decorator that opts out of tenant checks for a specific endpoint.
 * When present, CoreTenantGuard skips all tenant validation and does not set
 * tenantId or isAdminBypass on the request.
 *
 * Use this for endpoints that intentionally work without tenant context,
 * e.g., listing available tenants, user profile endpoints, etc.
 *
 * @example
 * ```typescript
 * @SkipTenantCheck()
 * @Roles(RoleEnum.S_USER)
 * async listMyTenants() { ... }
 * ```
 */
export const SkipTenantCheck = () => SetMetadata(SKIP_TENANT_CHECK_KEY, true);

/**
 * Parameter decorator that extracts the validated tenant ID from the current request.
 * Returns `undefined` if no tenant header is set or the endpoint has @SkipTenantCheck().
 *
 * Reads from RequestContext (set by CoreTenantGuard → req.tenantId →
 * RequestContextMiddleware lazy getter → context.tenantId), so it works
 * consistently across HTTP and GraphQL without context-type switching.
 *
 * @example
 * ```typescript
 * @Get('projects')
 * @Roles(DefaultHR.MEMBER)
 * async listProjects(@CurrentTenant() tenantId: string | undefined) {
 *   // tenantId comes from X-Tenant-Id header, validated by CoreTenantGuard
 * }
 * ```
 */
export const CurrentTenant = createParamDecorator((): string | undefined => {
  return RequestContext.get()?.tenantId;
});
