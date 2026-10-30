/**
 * THE CORE MODULE PARITY MATRIX — what the framework's own modules must do, executed through their API (REST and
 * GraphQL) against every database.
 *
 * Same discipline as `tests/helpers/persistence-matrix.ts`, one level up: that matrix proves the data store behaves
 * alike on every database and engine; this one proves the modules built on it — users, tenants, API tokens, the
 * operational endpoints — answer alike on MongoDB and on PostgreSQL, assembled the way a project assembles them. A
 * (case, driver) cell is EXECUTED, IMPOSSIBLE or DIFFERENT-BY-DESIGN, and `tests/unit/core-module-parity-matrix.spec.ts`
 * fails the build on anything else.
 *
 * One column per SQL database, on the default engine (TypeORM): the store is the only place an engine is visible, and
 * the persistence matrix runs every engine against it. Every column runs Better-Auth beside the legacy endpoints, as the
 * reference server does: the user cases sign in through the legacy endpoints, the IAM cases through Better-Auth, whose
 * adapter runs on each database (DEV-3904 added MySQL and MariaDB). The IAM suites cover Better-Auth in depth in their
 * own vitest projects; these cases pin its security rules on every column.
 *
 * Executor: `tests/core-module-parity.e2e-spec.ts`.
 */
import { it } from 'vitest';

export type CoreModuleDriver = 'mariadb' | 'mongodb' | 'mysql' | 'postgres';

export const CORE_MODULE_DRIVERS: readonly CoreModuleDriver[] = ['mongodb', 'postgres', 'mysql', 'mariadb'] as const;

export interface CoreModuleCase {
  /** Drivers this case is EXECUTED for. Every driver not listed needs an exclusion entry. */
  drivers: readonly CoreModuleDriver[];
  id: string;
  title: string;
}

export interface CoreModuleExclusion {
  case: string;
  driver: CoreModuleDriver;
  /** Case id asserting the complement. Required for `DIFFERENT-BY-DESIGN:`, forbidden for `IMPOSSIBLE:`. */
  provenBy?: string;
  /** Must start with `IMPOSSIBLE:` or `DIFFERENT-BY-DESIGN:`. */
  reason: string;
}

const ALL = CORE_MODULE_DRIVERS;

export const CORE_MODULE_CASES: readonly CoreModuleCase[] = [
  // --- users and legacy sign-in --------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'user-sign-up',
    title: 'sign-up creates the user as its own creator, a second sign-up with the address is refused with 400',
  },
  { drivers: ALL, id: 'user-email-normalized', title: 'the address is stored trimmed and in lower case' },
  { drivers: ALL, id: 'user-sign-in', title: 'sign-in answers tokens for the right password and 401 for a wrong one' },
  {
    drivers: ALL,
    id: 'user-refresh-and-logout',
    title: 'a refresh token renews the session, an access token does not, and logout ends the refresh token',
  },
  { drivers: ALL, id: 'user-verify', title: 'the verification token verifies the user once' },
  {
    drivers: ALL,
    id: 'user-password-reset',
    title: 'a reset token sets a new password and ends the old sessions; the token works once',
  },
  {
    drivers: ALL,
    id: 'user-password-reset-expired',
    title: 'an expired reset token is refused like an unknown one and removed',
  },
  {
    drivers: ALL,
    id: 'user-update-self',
    title: 'a user changes their own name and password, and may not change another user',
  },
  {
    drivers: ALL,
    id: 'user-roles',
    title: 'an administrator assigns roles, a user cannot grant themselves one, a system role is never stored',
  },
  {
    drivers: ALL,
    id: 'user-find-and-count',
    title: 'an administrator filters, sorts, pages and counts users; a user may not list them',
  },
  { drivers: ALL, id: 'user-delete', title: 'an administrator deletes a user, who can no longer sign in' },

  // --- IAM (Better-Auth) -----------------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'iam-sign-up-and-sign-in',
    title: 'an IAM sign-up creates the one user the user model reads, and sign-in answers a session for the right password only',
  },
  {
    drivers: ALL,
    id: 'iam-roles-not-input',
    title: 'neither the IAM sign-up nor update-user lets a user give themselves a role',
  },
  {
    drivers: ALL,
    id: 'iam-password-hashed',
    title: 'the IAM credential stores a scrypt hash, and the legacy password a bcrypt hash, never the password',
  },
  {
    drivers: ALL,
    id: 'iam-session-revoked',
    title: 'signing out ends the session: its token no longer resolves to the user',
  },

  // --- tenants -------------------------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'tenant-member-access',
    title: 'a member reaches a tenant route in its tenant; a non-member and a member of another tenant get 403',
  },
  {
    drivers: ALL,
    id: 'tenant-membership-lifecycle',
    title: 'removing a member ends the access, adding it again reactivates the one membership',
  },
  {
    drivers: ALL,
    id: 'tenant-role-hierarchy',
    title: 'an owner route admits the owner and refuses a member until the member is promoted',
  },
  { drivers: ALL, id: 'tenant-last-owner', title: 'the last owner can be neither removed nor demoted' },
  {
    drivers: ALL,
    id: 'tenant-ids-without-header',
    title: 'without a tenant header the caller works in every tenant it is an active member of',
  },
  {
    drivers: ALL,
    id: 'tenant-inactive',
    title: 'a tenant switched off through isTenantActive (a data-store lookup) refuses its members',
  },

  // --- API tokens ----------------------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'api-token-user-lifecycle',
    title: 'a user token acts as its user on a released route, nowhere else, and stops working once revoked',
  },
  {
    drivers: ALL,
    id: 'api-token-no-global-roles',
    title: 'an administrator’s user token carries no administrator rights',
  },
  {
    drivers: ALL,
    id: 'api-token-tenant-token',
    title: 'a tenant token reaches its own tenant only, and stops working once deleted',
  },
  {
    drivers: ALL,
    id: 'api-token-revoked-on-password-reset',
    title: 'a password reset revokes the user’s tokens, found by the address',
  },
  {
    drivers: ALL,
    id: 'api-token-last-used',
    title: 'using a token stamps lastUsedAt without changing the token’s update time',
  },

  // --- operations ----------------------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'health-check-every-database',
    title: 'the health check reports every configured database, each under its own key',
  },
  {
    drivers: ALL,
    id: 'hub-persistence-panel',
    title: 'the Hub shows each model with its source, database and capabilities, without credentials',
  },
  {
    drivers: ALL,
    id: 'hub-migrations-panel',
    title: 'the Hub reads the migration state where the framework keeps it',
  },
  {
    drivers: ALL,
    id: 'error-codes-and-permissions',
    title: 'the error-code catalog and the permissions report answer as on every database (no data access)',
  },
];

export const CORE_MODULE_EXCLUSIONS: readonly CoreModuleExclusion[] = [];

export function getCoreModuleCase(id: string): CoreModuleCase {
  const found = CORE_MODULE_CASES.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`Unknown core module case '${id}'. Declare it in tests/helpers/core-module-matrix.ts.`);
  }
  return found;
}

export function getCoreModuleExclusion(id: string, driver: CoreModuleDriver): CoreModuleExclusion | undefined {
  return CORE_MODULE_EXCLUSIONS.find((entry) => entry.case === id && entry.driver === driver);
}

/** Register an executed cell; refuses a driver the matrix does not list for the case. */
export function moduleIt(id: string, driver: CoreModuleDriver, body: () => Promise<void> | void): void {
  const spec = getCoreModuleCase(id);
  if (!spec.drivers.includes(driver)) {
    throw new Error(`Core module case '${id}' is not declared for driver '${driver}'.`);
  }
  it(spec.title, body);
}

/** Register the complement of a `DIFFERENT-BY-DESIGN:` exclusion. */
export function moduleComplement(id: string, driver: CoreModuleDriver, body: () => Promise<void> | void): void {
  const exclusion = getCoreModuleExclusion(id, driver);
  if (!exclusion?.reason.startsWith('DIFFERENT-BY-DESIGN:')) {
    throw new Error(`Core module case '${id}' is not excluded as DIFFERENT-BY-DESIGN for '${driver}'.`);
  }
  it(`instead of "${getCoreModuleCase(id).title}": ${exclusion.reason.replace('DIFFERENT-BY-DESIGN: ', '')}`, body);
}
