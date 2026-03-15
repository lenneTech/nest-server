/**
 * Injection token for the TenantMember Mongoose model.
 * Use this constant instead of the string literal 'TenantMember' in @InjectModel() and getModelToken().
 */
export const TENANT_MEMBER_MODEL_TOKEN = 'TenantMember';

/**
 * Membership status for tenant members.
 */
export enum TenantMemberStatus {
  ACTIVE = 'ACTIVE',
  /** Reserved for future invitation workflow (not yet used in core logic) */
  INVITED = 'INVITED',
  SUSPENDED = 'SUSPENDED',
}

/**
 * Default role hierarchy for tenant membership.
 * Keys are role names (stored in membership documents), values are numeric levels.
 * Higher value = more privileges. Multiple roles can share the same level.
 *
 * Can be customized via `multiTenancy.roleHierarchy` in config.
 *
 * Hierarchy roles use level comparison: a higher level includes all lower levels.
 * Non-hierarchy roles (not in this config) use exact match only.
 *
 * @example Custom hierarchy:
 * ```typescript
 * const roleHierarchy = { viewer: 1, editor: 2, manager: 2, owner: 3 };
 * const HR = createHierarchyRoles(roleHierarchy);
 * // HR.VIEWER = 'viewer', HR.EDITOR = 'editor', HR.MANAGER = 'manager', HR.OWNER = 'owner'
 * ```
 */
export const DEFAULT_ROLE_HIERARCHY: Record<string, number> = {
  member: 1,
  manager: 2,
  owner: 3,
};

/**
 * Generate typed UPPER_CASE constants from a role hierarchy config.
 * Provides type-safe role strings for use with @Roles() and @Restricted() decorators.
 *
 * @example
 * ```typescript
 * const hierarchy = { viewer: 1, editor: 2, manager: 2, owner: 3 };
 * const HR = createHierarchyRoles(hierarchy);
 * // HR.VIEWER = 'viewer', HR.EDITOR = 'editor', HR.MANAGER = 'manager', HR.OWNER = 'owner'
 *
 * @Roles(HR.EDITOR) // requires at least level 2
 * ```
 *
 * @returns Object with UPPER_CASE keys mapped to the original lowercase role name strings.
 *          E.g. `{ viewer: 1, owner: 3 }` → `{ VIEWER: 'viewer', OWNER: 'owner' }`.
 */
export function createHierarchyRoles<T extends Record<string, number>>(
  hierarchy: T,
): { [K in keyof T as Uppercase<string & K>]: string & K } {
  const result = {} as any;
  for (const key of Object.keys(hierarchy)) {
    result[key.toUpperCase()] = key;
  }
  return result;
}

/**
 * Type-safe constants for the default role hierarchy.
 * Convenience export for projects using the default { member: 1, manager: 2, owner: 3 } hierarchy.
 *
 * @example
 * ```typescript
 * @Roles(DefaultHR.MEMBER)   // any active member (level >= 1)
 * @Roles(DefaultHR.MANAGER)  // at least manager level (level >= 2)
 * @Roles(DefaultHR.OWNER)    // highest level only (level >= 3)
 * ```
 */
export const DefaultHR = createHierarchyRoles(DEFAULT_ROLE_HIERARCHY);
