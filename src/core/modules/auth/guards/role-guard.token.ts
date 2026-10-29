/**
 * DI token under which the module that registers the global role guard (`RolesGuard` in `CoreAuthModule`,
 * `BetterAuthRolesGuard` in `CoreBetterAuthModule`) also provides it — so `CoreTenantGuard` reaches the role guard of
 * its own application without importing it. Import-free leaf (see `.claude/rules/architecture.md` → "DI Token
 * Placement (SWC-Safe)").
 */
export const ROLE_GUARD = 'LtRoleGuard';
