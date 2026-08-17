import { isForbiddenMembershipRole, isGlobalOnlyRole, looksLikeSystemRole } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { RoleScope, roleScopeRegistry, RoleScopeSource } from './core-role-scope.registry';
import { DEFAULT_ROLE_HIERARCHY } from './core-tenant.enums';

/**
 * Merge handler-level and class-level @Roles() metadata arrays into a single flat array.
 * Used by RolesGuard, BetterAuthRolesGuard, and CoreTenantGuard.
 *
 * OR semantics: class-level roles serve as a base that method-level roles extend.
 * Example: class @Roles(ADMIN) + method @Roles(S_USER) → [S_USER, ADMIN] — both are alternatives.
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

// `isSystemRole` used to be defined here. It now lives in `common/enums/role.enum.ts`, next to the
// RoleEnum members it describes, so the storage guards and the runtime guards share ONE predicate
// instead of drifting apart (they already disagreed on case). Re-exported below for compatibility.
export {
  GLOBAL_ONLY_ROLES,
  isForbiddenMembershipRole,
  isGlobalOnlyRole,
  isSystemRole,
  looksLikeGlobalOnlyRole,
  looksLikeSystemRole,
  SYSTEM_ROLE_PREFIX,
} from '../../common/enums/role.enum';

/**
 * Feeds the role-scope registry from `multiTenancy` config.
 *
 * Reads the config lazily on every call rather than caching, so a `ConfigService.setConfig()` in a
 * test (or a future runtime reload) is picked up without re-registering the source.
 */
export const configRoleScopeSource: RoleScopeSource = {
  globalRoles: () => ConfigService.configFastButReadOnly?.multiTenancy?.globalOnlyRoles ?? [],
  tenantRoles: () => {
    const config = ConfigService.configFastButReadOnly?.multiTenancy;
    return [
      ...Object.keys(config?.roleHierarchy ?? DEFAULT_ROLE_HIERARCHY),
      ...(config?.additionalMembershipRoles ?? []),
    ];
  },
};

/**
 * Validate the configured role vocabulary. Throws when it cannot be enforced coherently.
 *
 * Called at boot (`CoreTenantModule`). Failing the boot is the right severity: every condition here
 * describes a configuration whose access decisions would be ambiguous or silently wrong, and an
 * ambiguous authorization rule is worse than a server that refuses to start.
 */
export function assertRoleVocabularyIsCoherent(): void {
  const config = ConfigService.configFastButReadOnly?.multiTenancy;
  if (!config || config.enabled === false) {
    return;
  }

  const hierarchy = Object.keys(config.roleHierarchy ?? DEFAULT_ROLE_HIERARCHY);
  const additional = config.additionalMembershipRoles ?? [];
  const declaredGlobal = config.globalOnlyRoles ?? [];

  // 1. A tenant role must never be named after a framework role.
  const reserved = [...hierarchy, ...additional].filter((role) => isForbiddenMembershipRole(role));
  if (reserved.length) {
    throw new Error(
      `multiTenancy: tenant role(s) [${reserved.join(', ')}] use a reserved framework role name. ` +
        'A tenant role of that name would be compared against the framework role by exact string match, ' +
        'letting a tenant owner grant themselves platform authority. Rename them (e.g. "tenantAdmin") ' +
        'and declare platform-wide roles via multiTenancy.globalOnlyRoles.',
    );
  }

  // 2. A role cannot be global and tenant-scoped at once — it would need two sources of truth.
  const both = declaredGlobal.filter((role) => hierarchy.includes(role) || additional.includes(role));
  if (both.length) {
    throw new Error(
      `multiTenancy: role(s) [${both.join(', ')}] are declared BOTH in globalOnlyRoles and as tenant roles. ` +
        'Each role must resolve against exactly one source (user.roles for global, membership.role for tenant).',
    );
  }

  // 3. A declared global role must not be a system role either.
  const systemGlobals = declaredGlobal.filter((role) => looksLikeSystemRole(role));
  if (systemGlobals.length) {
    throw new Error(
      `multiTenancy.globalOnlyRoles contains system role(s) [${systemGlobals.join(', ')}]. ` +
        'System roles are runtime-context checks and are never stored or granted.',
    );
  }
}

/**
 * Split required roles into the ones only the PLATFORM can satisfy and the ones a TENANT can.
 *
 * This split is the tenant boundary. Membership roles are customer-assigned free text, and in
 * tenant context they are compared against required roles by exact string match — so without the
 * split, a member whose tenant role is literally `'admin'` satisfies `@Roles(RoleEnum.ADMIN)`, the
 * global platform role. Anyone allowed to manage members (a tenant owner, i.e. a customer) could
 * mint platform-wide access for themselves.
 *
 * Callers must resolve each half against its own source:
 * - `global` → `user.roles` (never the membership role)
 * - `tenant` → `membership.role` in tenant context, `user.roles` otherwise
 *
 * OR semantics across the two halves: satisfying either is enough, which keeps
 * `@Roles(ADMIN, 'owner')` working as the alternative it reads as.
 */
export function resolveGlobalAndTenantRoles(requiredRoles: string[]): { global: string[]; tenant: string[] } {
  const global: string[] = [];
  const tenant: string[] = [];
  for (const role of requiredRoles ?? []) {
    // The registry knows framework roles, project-declared global roles and configured tenant
    // roles. `isGlobalOnlyRole` is kept as the floor so RoleEnum.ADMIN is global even before any
    // source is registered (e.g. a unit test constructing the helper in isolation).
    const scope = roleScopeRegistry.scopeOf(role);
    (scope === RoleScope.GLOBAL || isGlobalOnlyRole(role) ? global : tenant).push(role);
  }
  return { global, tenant };
}

/**
 * Which required roles may a TENANT MEMBERSHIP satisfy?
 *
 * Two tiers, and the distinction is the whole design:
 *
 * 1. **Unconditional** — roles with GLOBAL scope are never satisfiable by a membership. This is the
 *    security fix: a customer-assigned role must not answer for the platform. Always on.
 * 2. **Opt-in** (`multiTenancy.strictMembershipRoles`) — narrow further to roles the project
 *    DECLARED as tenant-scoped, so an undeclared name cannot line up with a membership by
 *    coincidence.
 *
 * Tier 2 is not the default on purpose. A project may legitimately use exact-match roles that
 * appear only in `@Roles()` and in its membership data and never in `roleHierarchy`; denying those
 * at the guard by default would be a silent, fleet-wide lockout — a worse failure than the case it
 * guards against, which tier 1 already covers as soon as the role is declared global.
 */
export function tenantSatisfiableRoles(requiredRoles: string[]): string[] {
  // Always excluded: roles whose authority is global. That is the security fix, and it is
  // unconditional — a customer-assigned membership role must never answer for the platform.
  const candidates = resolveGlobalAndTenantRoles(requiredRoles).tenant;

  // Beyond that, opt-in. `strictMembershipRoles` narrows matching to roles the project actually
  // DECLARED, so an undeclared name cannot line up with a membership by coincidence.
  //
  // It is deliberately NOT the default: a project may legitimately use exact-match roles that
  // appear only in @Roles() and in its membership data, never in roleHierarchy. Denying those by
  // default would break such setups at the guard — a silent, fleet-wide lockout — for a case the
  // global/tenant split already covers as soon as the role is declared global.
  if (!ConfigService.configFastButReadOnly?.multiTenancy?.strictMembershipRoles) {
    return candidates;
  }

  return candidates.filter((role) => roleScopeRegistry.isTenantRole(role));
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
