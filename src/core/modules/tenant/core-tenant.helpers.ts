import { ConfigService } from '../../common/services/config.service';
import { DEFAULT_ROLE_HIERARCHY } from './core-tenant.enums';

const SYSTEM_ROLE_PREFIX = 's_';

/**
 * Merge handler-level and class-level @Roles() metadata arrays into a single flat array.
 * Used by RolesGuard, BetterAuthRolesGuard, and CoreTenantGuard to avoid code duplication.
 *
 * @param meta - Two-element tuple [handlerRoles, classRoles] from Reflector.getAll or Reflect.getMetadata
 */
export function mergeRolesMetadata(meta: (string[] | undefined)[]): string[] {
  return meta[0] ? (meta[1] ? [...meta[0], ...meta[1]] : meta[0]) : meta[1] || [];
}

/**
 * Get the configured role hierarchy or the default.
 */
export function getRoleHierarchy(): Record<string, number> {
  return ConfigService.configFastButReadOnly?.multiTenancy?.roleHierarchy ?? DEFAULT_ROLE_HIERARCHY;
}

/**
 * Check if a role is a system role (S_USER, S_EVERYONE, etc.).
 * System roles are handled by RolesGuard, not CoreTenantGuard.
 */
export function isSystemRole(role: string): boolean {
  return role.startsWith(SYSTEM_ROLE_PREFIX);
}

/**
 * Check if multiTenancy is configured and enabled.
 */
export function isMultiTenancyActive(): boolean {
  const config = ConfigService.configFastButReadOnly?.multiTenancy;
  return !!config && config.enabled !== false;
}

/**
 * Check if a role is a hierarchy role (present in the configured role hierarchy).
 * Returns false when multiTenancy is disabled to avoid false positives.
 */
export function isHierarchyRole(role: string): boolean {
  if (!isMultiTenancyActive()) return false;
  const hierarchy = getRoleHierarchy();
  return role in hierarchy;
}

/**
 * Get the minimum required level from a set of roles.
 * Only considers roles that exist in the hierarchy.
 * Returns undefined if no hierarchy roles found.
 */
export function getMinRequiredLevel(roles: string[]): number | undefined {
  const hierarchy = getRoleHierarchy();
  const levels = roles.filter((r) => r in hierarchy).map((r) => hierarchy[r]);
  if (levels.length === 0) return undefined;
  return Math.min(...levels);
}

/**
 * Unified role access check for both tenant and non-tenant context.
 * Handles hierarchy roles (level comparison) AND normal roles (exact match).
 *
 * @param requiredRoles - roles from @Roles/@Restricted (system roles should be filtered out by caller)
 * @param userRoles - user.roles array (used when no tenantRole)
 * @param tenantRole - membership.role (used when tenant context active)
 *
 * When tenantRole is set: checks against [tenantRole] (tenant overrides user.roles)
 * When no tenantRole: checks against userRoles
 *
 * Hierarchy roles → level comparison (higher includes lower)
 * Normal roles → exact match (no compensation by higher role)
 *
 * OR semantics: any match (hierarchy OR normal) is sufficient.
 */
export function checkRoleAccess(requiredRoles: string[], userRoles?: string[], tenantRole?: string): boolean {
  const availableRoles = tenantRole ? [tenantRole] : (userRoles ?? []);
  if (availableRoles.length === 0) return false;

  // When multiTenancy is disabled, treat all roles as normal (exact match only)
  const multiTenancyActive = isMultiTenancyActive();
  const hierarchy = multiTenancyActive ? getRoleHierarchy() : {};
  const hierarchyRequired = requiredRoles.filter((r) => r in hierarchy);
  const nonHierarchyRequired = requiredRoles.filter((r) => !(r in hierarchy));

  if (hierarchyRequired.length === 0 && nonHierarchyRequired.length === 0) return true;

  // OR semantics: any category match is sufficient

  // Hierarchy roles: level comparison (higher includes lower)
  if (hierarchyRequired.length > 0) {
    const minRequired = Math.min(...hierarchyRequired.map((r) => hierarchy[r]));
    if (availableRoles.some((r) => r in hierarchy && hierarchy[r] >= minRequired)) return true;
  }

  // Non-hierarchy roles: exact match
  if (nonHierarchyRequired.length > 0) {
    if (nonHierarchyRequired.some((r) => availableRoles.includes(r))) return true;
  }

  return false;
}
