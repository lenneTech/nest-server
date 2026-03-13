/**
 * Role within a tenant.
 * Used for tenant-level authorization via @TenantRoles() decorator.
 */
export enum TenantRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
}

/**
 * Membership status for tenant members.
 */
export enum TenantMemberStatus {
  ACTIVE = 'ACTIVE',
  INVITED = 'INVITED',
  SUSPENDED = 'SUSPENDED',
}

/**
 * Numeric hierarchy for tenant roles.
 * Higher value = more privileges.
 */
export const TENANT_ROLE_HIERARCHY: Record<TenantRole, number> = {
  [TenantRole.MEMBER]: 1,
  [TenantRole.ADMIN]: 2,
  [TenantRole.OWNER]: 3,
};
