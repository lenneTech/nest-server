/**
 * THE PERSISTENCE PARITY MATRIX — one declaration of what a data store must do, executed against every
 * database (and, on SQL, every engine).
 *
 * Same discipline as `tests/helpers/file-storage-matrix.ts`, for the same reason: one contract with several
 * implementations is tested ONCE, against all of them, or a behaviour that holds on one database and not on
 * another has nowhere to show up. A (case, driver) cell is in one of three declared states, and
 * `tests/unit/persistence-parity-matrix.spec.ts` fails the build on anything else:
 *
 *   EXECUTED     — the case lists the driver; the executor registers a real `it()` via `persistenceIt()`.
 *   IMPOSSIBLE   — an exclusion whose reason starts with `IMPOSSIBLE:`; nothing is registered.
 *   BY DESIGN    — an exclusion whose reason starts with `DIFFERENT-BY-DESIGN:`; it MUST name a `provenBy`
 *                  case run for that driver, and the executor registers the complement via
 *                  `persistenceComplement()`. A design difference nobody asserts is indistinguishable from a
 *                  bug nobody noticed.
 *
 * Phase 0 of the database-agnostic work filled the MongoDB column; phase 1 added PostgreSQL once per engine
 * (TypeORM, Kysely, Drizzle), phase 6 MySQL 8.4 and MariaDB 11.8 once per engine. Every case is executed in every
 * column, or declared with a reason.
 *
 * Executor: `tests/persistence-parity.e2e-spec.ts`.
 */
import { it } from 'vitest';

export type PersistenceEngine = 'drizzle' | 'kysely' | 'typeorm';
export type PersistenceDriver =
  | 'mongodb'
  | `mariadb-${PersistenceEngine}`
  | `mysql-${PersistenceEngine}`
  | `postgres-${PersistenceEngine}`;

export const PERSISTENCE_DRIVERS: readonly PersistenceDriver[] = [
  'mongodb',
  'postgres-typeorm',
  'postgres-kysely',
  'postgres-drizzle',
  'mysql-typeorm',
  'mysql-kysely',
  'mysql-drizzle',
  'mariadb-typeorm',
  'mariadb-kysely',
  'mariadb-drizzle',
] as const;

export interface PersistenceCase {
  /** Drivers this case is EXECUTED for. Every driver not listed needs an exclusion entry. */
  drivers: readonly PersistenceDriver[];
  id: string;
  title: string;
}

export interface PersistenceExclusion {
  case: string;
  driver: PersistenceDriver;
  /** Case id asserting the complement. Required for `DIFFERENT-BY-DESIGN:`, forbidden for `IMPOSSIBLE:`. */
  provenBy?: string;
  /** Must start with `IMPOSSIBLE:` or `DIFFERENT-BY-DESIGN:`. */
  reason: string;
}

const ALL = PERSISTENCE_DRIVERS;
const POSTGRES = PERSISTENCE_DRIVERS.filter((driver) => driver.startsWith('postgres-'));
/** MySQL and MariaDB: the columns without row-level security */
export const MYSQL_DRIVERS = PERSISTENCE_DRIVERS.filter(
  (driver) => driver.startsWith('mysql-') || driver.startsWith('mariadb-'),
);

export const PERSISTENCE_CASES: readonly PersistenceCase[] = [
  // --- CRUD contract --------------------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'insert-returns-string-id',
    title: 'insert returns the stored record with its id as a string, without _id',
  },
  { drivers: ALL, id: 'find-by-id', title: 'findById returns the record, and null for an unknown id' },
  { drivers: ALL, id: 'find-where-sort-skip-limit', title: 'find applies the filter, sort, skip and limit' },
  { drivers: ALL, id: 'find-by-neutral-id', title: 'find and findOne address the id as `id`, also inside $or' },
  { drivers: ALL, id: 'find-one', title: 'findOne returns the first match, and null without one' },
  { drivers: ALL, id: 'find-select', title: 'select returns the requested fields and always the id' },
  {
    drivers: ALL,
    id: 'select-hidden-fields',
    title: 'a select: false field is left out unless it is selected by name',
  },
  {
    drivers: ALL,
    id: 'select-plain-names-only',
    title: 'select refuses a name with a projection modifier (+field, -field)',
  },
  { drivers: ALL, id: 'sort-missing-first', title: 'a missing value sorts first ascending and last descending' },
  { drivers: ALL, id: 'insert-applies-defaults', title: 'insert applies literal, function and array defaults' },
  { drivers: ALL, id: 'count', title: 'count counts the matches' },
  { drivers: ALL, id: 'distinct', title: 'distinct returns each value once' },
  { drivers: ALL, id: 'distinct-array-items', title: 'distinct over an array field returns its items' },
  {
    drivers: ALL,
    id: 'update-partial',
    title: 'updateById with a partial record sets those fields (an ObjectId value included) and returns the result',
  },
  { drivers: ALL, id: 'update-operators', title: 'updateById applies $inc and $unset' },
  {
    drivers: ALL,
    id: 'update-undefined-ignored',
    title: 'an update leaves a field given as undefined unchanged, in a partial record and in $set',
  },
  { drivers: ALL, id: 'update-nested-path', title: 'updateById sets and increments paths inside an embedded object' },
  { drivers: ALL, id: 'update-array-operators', title: 'updateById applies $push, $addToSet and $pull' },
  {
    drivers: ALL,
    id: 'duplicate-key-11000',
    title: 'a duplicate unique value fails with code 11000 and an E11000 message',
  },
  { drivers: ALL, id: 'delete-by-id', title: 'deleteById removes the record and returns it' },
  {
    drivers: ALL,
    id: 'update-one-first-match',
    title: 'updateOne changes the first record matching the filter and returns it, null without a match',
  },
  {
    drivers: ALL,
    id: 'update-one-concurrent',
    title: 'concurrent updateOne calls on one filter each take a different record, none is lost',
  },
  { drivers: ALL, id: 'delete-many', title: 'deleteMany removes every match and returns the count' },
  { drivers: ALL, id: 'sum', title: 'sum counts the matches and totals a numeric field, a missing value as 0' },
  { drivers: ALL, id: 'find-exclude', title: 'exclude leaves fields out of a read, never the id, never with select' },
  {
    drivers: ALL,
    id: 'find-sample',
    title: 'find with sample returns that many random records of the page, after filter, sort, skip and limit',
  },
  { drivers: ALL, id: 'delete-one', title: 'deleteOne removes the first match and returns it, null without one' },
  { drivers: ALL, id: 'update-many', title: 'updateMany applies the update to every match and returns the count' },
  {
    drivers: ALL,
    id: 'update-without-timestamps',
    title: 'an update with timestamps: false leaves the update time as it is',
  },
  { drivers: ALL, id: 'push-with-slice', title: 'pushToArray appends atomically and keeps the last n with slice' },
  { drivers: ALL, id: 'push-position-and-sort', title: 'pushToArray inserts at a position and sorts the array' },
  {
    drivers: ALL,
    id: 'push-combined-modifiers',
    title: 'pushToArray applies position, sort and slice of one call together, in MongoDB’s order',
  },
  {
    drivers: ALL,
    id: 'push-concurrent',
    title: '20 concurrent pushToArray calls on one record all land (atomic, no lost update)',
  },
  { drivers: ALL, id: 'pull-by-condition', title: 'pullFromArray removes the matching items' },
  { drivers: ALL, id: 'array-field-guard', title: 'array operations refuse an operator or empty field name' },
  {
    drivers: ALL,
    id: 'native-access-needs-reason',
    title: 'native() and raw() refuse an access without a meaningful reason',
  },
  // --- Through a CrudService (what a project's service runs on the store) ---------------------------------------
  {
    drivers: ALL,
    id: 'crud-service-pipeline',
    title: 'a CrudService creates, reads, finds, counts, updates and deletes through the store',
  },
  {
    drivers: ALL,
    id: 'crud-service-populate',
    title: 'a CrudService populates a reference with the referenced record',
  },
  // --- Security policies (before-layer and after-layer) ---------------------------------------------------------
  { drivers: ALL, id: 'tenant-filters-reads', title: 'a tenant sees only its own rows' },
  { drivers: ALL, id: 'tenant-stamps-writes', title: 'a write in a tenant context is stamped with that tenant' },
  { drivers: ALL, id: 'tenant-refuses-foreign-write', title: 'a write naming another tenant is refused' },
  { drivers: ALL, id: 'tenant-safety-net', title: 'tenant-scoped data without a tenant context is refused' },
  { drivers: ALL, id: 'tenant-foreign-update-misses', title: 'an update of another tenant’s record finds nothing' },
  {
    drivers: ALL,
    id: 'tenant-filters-update-one-and-delete-many',
    title: 'updateOne, updateMany, deleteOne and deleteMany reach only the rows of the current tenant',
  },
  {
    drivers: ALL,
    id: 'tenant-filters-aggregates',
    title: 'count, sum and distinct (also over array items) see only the rows of the current tenant',
  },
  {
    drivers: ALL,
    id: 'tenant-push-pull-misses',
    title: 'pushToArray and pullFromArray on another tenant’s record leave it unchanged',
  },
  { drivers: ALL, id: 'audit-stamps-actor', title: 'createdBy and updatedBy carry the acting user' },
  { drivers: ALL, id: 'password-hashed', title: 'a password is stored hashed, never in plaintext' },
  { drivers: ALL, id: 'system-role-refused', title: 'a system role is never stored' },
  { drivers: ALL, id: 'role-change-stripped', title: 'a role change by a non-admin is stripped' },
  {
    drivers: ALL,
    id: 'role-push-pull-stripped',
    title: 'pushToArray and pullFromArray on roles by a non-admin change nothing',
  },
  {
    drivers: POSTGRES,
    id: 'native-api-tenant-refused',
    title: 'a query on a tenant table through the native engine API is refused by the database without a tenant scope',
  },
];

export const PERSISTENCE_EXCLUSIONS: readonly PersistenceExclusion[] = [
  {
    case: 'native-api-tenant-refused',
    driver: 'mongodb',
    provenBy: 'tenant-safety-net',
    reason:
      'DIFFERENT-BY-DESIGN: MongoDB has no database-level isolation; the native Mongoose model keeps the tenant ' +
      'plugin, which filters by the tenant, refuses a request without one, and lets system work through',
  },
  ...MYSQL_DRIVERS.map((driver): PersistenceExclusion => ({
    case: 'native-api-tenant-refused',
    driver,
    provenBy: 'tenant-safety-net',
    reason:
      'DIFFERENT-BY-DESIGN: MySQL and MariaDB have no row-level security; tenant isolation is the store’s, so a ' +
      'query through the native engine API reaches every tenant’s rows — the boot log says so, and native access ' +
      'on a tenant table must filter by tenantId itself',
  })),
];

export function getPersistenceCase(id: string): PersistenceCase {
  const found = PERSISTENCE_CASES.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`Unknown persistence case '${id}'. Declare it in tests/helpers/persistence-matrix.ts.`);
  }
  return found;
}

export function getPersistenceExclusion(id: string, driver: PersistenceDriver): PersistenceExclusion | undefined {
  return PERSISTENCE_EXCLUSIONS.find((entry) => entry.case === id && entry.driver === driver);
}

/** Register an executed cell; refuses a driver the matrix does not list for the case. */
export function persistenceIt(id: string, driver: PersistenceDriver, body: () => Promise<void> | void): void {
  const spec = getPersistenceCase(id);
  if (!spec.drivers.includes(driver)) {
    throw new Error(`Persistence case '${id}' is not declared for driver '${driver}'.`);
  }
  it(spec.title, body);
}

/** Register the complement of a `DIFFERENT-BY-DESIGN:` exclusion. */
export function persistenceComplement(id: string, driver: PersistenceDriver, body: () => Promise<void> | void): void {
  const exclusion = getPersistenceExclusion(id, driver);
  if (!exclusion?.reason.startsWith('DIFFERENT-BY-DESIGN:')) {
    throw new Error(`Persistence case '${id}' is not excluded as DIFFERENT-BY-DESIGN for '${driver}'.`);
  }
  it(`instead of "${getPersistenceCase(id).title}": ${exclusion.reason.replace('DIFFERENT-BY-DESIGN: ', '')}`, body);
}
