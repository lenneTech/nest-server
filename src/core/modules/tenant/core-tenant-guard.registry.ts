/**
 * Whether a tenant guard is actually REGISTERED in this process — as opposed to merely configured.
 *
 * `RolesGuard` and `BetterAuthRolesGuard` hand every non-system role over to the tenant guard when
 * multi-tenancy is on, because that guard resolves them against the membership. Deciding that from
 * CONFIGURATION alone meant: whenever configuration and registration were out of step, a role such
 * as `RoleEnum.ADMIN` was handed to a guard that never ran, and every authenticated caller passed.
 * The role guards therefore delegate only while this registry reports an active tenant guard.
 *
 * Counted, not flagged: `CoreTenantModule` registers (so a project's own guard class counts too), and
 * so does `CoreTenantGuard` itself (for setups that list it as an APP_GUARD directly). Each disposer
 * releases exactly its own registration.
 *
 * A true leaf: no imports (see `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)").
 */

let activeTenantGuards = 0;

/**
 * Record an active tenant guard. Returns a disposer that releases this registration exactly once.
 */
export function registerActiveTenantGuard(): () => void {
  activeTenantGuards++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeTenantGuards = Math.max(0, activeTenantGuards - 1);
    }
  };
}

/** Is at least one tenant guard registered in this process? */
export function hasActiveTenantGuard(): boolean {
  return activeTenantGuards > 0;
}
