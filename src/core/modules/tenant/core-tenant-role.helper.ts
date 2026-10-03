import { looksLikeSystemRole } from '../../common/enums/role.enum';
import { accessDeniedException } from '../../common/exceptions/access-denied.exception';
import { RequestContext } from '../../common/services/request-context.service';
import { checkRoleAccess, resolveGlobalAndTenantRoles, tenantSatisfiableRoles } from './core-tenant.helpers';

/**
 * Service-level tenant role checks.
 *
 * `@Roles()` protects a controller or resolver method — the route, not the operation. A service is
 * also reached from MCP tools, AI tools, queue processors and other services, and on those paths a
 * tenant role the controller demands is demanded by nobody. Checking in the service closes every
 * entry point at once.
 *
 * The decision mirrors `CoreTenantGuard` on the tenant-header path:
 * - an administrator under `adminBypass` passes,
 * - a GLOBAL role (`RoleEnum.ADMIN`, `multiTenancy.globalOnlyRoles`) is answered by `user.roles`,
 *   never by a membership role,
 * - a tenant role is answered by the validated `tenantRole` of the current request (hierarchy roles
 *   by level, others by exact match) — without tenant context there is nothing to compare, and it
 *   fails,
 * - system roles (`S_*`) are runtime checks of their own and never satisfy anything here.
 *
 * Several roles read as alternatives, as in `@Roles()`.
 */

/**
 * Whether the current request holds one of `roles` in its tenant. `false` without a signed-in user.
 */
export function hasTenantRole(...roles: string[]): boolean {
  const context = RequestContext.get();
  const user = context?.currentUser;
  if (!user) {
    return false;
  }
  if (context?.isAdminBypass) {
    return true;
  }

  const required = roles.filter((role) => typeof role === 'string' && !looksLikeSystemRole(role));
  const { global } = resolveGlobalAndTenantRoles(required);
  if (global.some((role) => user.roles?.includes(role))) {
    return true;
  }

  // The length guard matters: checkRoleAccess() answers TRUE for an empty required list.
  const tenantRoles = tenantSatisfiableRoles(required);
  return tenantRoles.length > 0 && !!context?.tenantRole && checkRoleAccess(tenantRoles, undefined, context.tenantRole);
}

/**
 * Refuses the current operation unless it holds one of `roles` in its tenant.
 *
 * Work the server does on its own — no request context at all, or one no client request created
 * (cron, migration, seed, `runWithBypass…()` outside a request) — passes: there is no caller whose
 * role could be wrong. An ANONYMOUS client request does not pass: it gets 401, and a signed-in caller
 * without the role gets 403.
 *
 * @example
 * ```typescript
 * async updateAiModels(input: AiModelsInput, serviceOptions?: ServiceOptions) {
 *   assertTenantRole(DefaultHR.OWNER, 'Only owners may change the AI models');
 *   …
 * }
 * ```
 */
export function assertTenantRole(roles: string | string[], message?: string): void {
  const context = RequestContext.get();
  if (!context?.currentUser && !context?.fromRequest) {
    return;
  }
  const list = Array.isArray(roles) ? roles : [roles];
  if (!hasTenantRole(...list)) {
    throw accessDeniedException(context?.currentUser, message);
  }
}
