/**
 * THE SYNC CONTRACT MATRIX — what the offline-sync protocol (`docs/offline-sync-protocol.md`) promises, executed through
 * its HTTP API against every database the sync module runs on.
 *
 * Same discipline as `tests/helpers/persistence-matrix.ts` and `tests/helpers/core-module-matrix.ts`: one list of
 * behaviours, every (case, driver) cell EXECUTED, IMPOSSIBLE or DIFFERENT-BY-DESIGN, and
 * `tests/unit/sync-contract-matrix.spec.ts` fails the build on anything else.
 *
 * Columns: MongoDB standalone, a MongoDB replica set (the test infrastructure's one-node set), PostgreSQL once per
 * engine, MySQL and MariaDB on the default engine — the persistence matrix runs every engine against the store, the
 * sync module never sees one. Executor: `tests/sync-contract.e2e-spec.ts`.
 */
import { it } from 'vitest';

export type SyncDriver =
  | 'mariadb'
  | 'mongodb'
  | 'mongodb-rs'
  | 'mysql'
  | 'postgres-drizzle'
  | 'postgres-kysely'
  | 'postgres-typeorm';

export const SYNC_DRIVERS: readonly SyncDriver[] = [
  'mongodb',
  'mongodb-rs',
  'postgres-typeorm',
  'postgres-kysely',
  'postgres-drizzle',
  'mysql',
  'mariadb',
] as const;

export const SYNC_MONGO_DRIVERS: readonly SyncDriver[] = ['mongodb', 'mongodb-rs'];
export const SYNC_SQL_DRIVERS: readonly SyncDriver[] = SYNC_DRIVERS.filter(
  (driver) => !SYNC_MONGO_DRIVERS.includes(driver),
);

export interface SyncCase {
  /** Drivers this case is EXECUTED for. Every driver not listed needs an exclusion entry. */
  drivers: readonly SyncDriver[];
  id: string;
  title: string;
}

export interface SyncExclusion {
  case: string;
  driver: SyncDriver;
  /** Case id asserting the complement. Required for `DIFFERENT-BY-DESIGN:`, forbidden for `IMPOSSIBLE:`. */
  provenBy?: string;
  /** Must start with `IMPOSSIBLE:` or `DIFFERENT-BY-DESIGN:`. */
  reason: string;
}

const ALL = SYNC_DRIVERS;

export const SYNC_CASES: readonly SyncCase[] = [
  // --- pull (protocol §5) --------------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'pull-full-state',
    title: 'a pull without cursor delivers every visible record and tombstone in pages, a cursor on every page',
  },
  {
    drivers: ALL,
    id: 'pull-resume',
    title: 'a cursor stored in the middle of a run continues it — nothing missing, nothing out of order',
  },
  {
    drivers: ALL,
    id: 'pull-delta',
    title: 'after a run, changes and deletions arrive with their final version, and the run ends',
  },
  {
    drivers: SYNC_SQL_DRIVERS,
    id: 'pull-no-repeats',
    title: 'an unchanged record is never delivered again (commit-ordered sequence, P2-2)',
  },
  {
    drivers: SYNC_MONGO_DRIVERS,
    id: 'pull-window-repeats',
    title: 'an unchanged record comes again only within the window W, never after it (server clock, P2-2)',
  },
  {
    drivers: ALL,
    id: 'pull-tombstone-shape',
    title: 'a tombstone carries id, version, deletedAt and updatedAt — and no content',
  },
  { drivers: ALL, id: 'pull-page-bytes', title: 'a page ends before maxBytes, with at least one item' },
  { drivers: ALL, id: 'pull-limit', title: 'limit is honoured and an invalid limit answers 400' },
  {
    drivers: ALL,
    id: 'pull-roles',
    title: 'without the pull roles 403, without a session 401, an unknown model 404',
  },
  {
    drivers: ALL,
    id: 'pull-security-check',
    title: 'a record the model hides from the caller never arrives, and the cursor still moves past it',
  },
  {
    drivers: ALL,
    id: 'pull-change-between-reads',
    title:
      'a record changed between the position read and the content read keeps the cursor on its old position: ' +
      'nothing after it is skipped, and its change comes again at its new position',
  },
  {
    drivers: ALL,
    id: 'pull-across-tenants',
    title: 'without X-Tenant-Id the memberships are read per tenant and merged — every record once, in change order',
  },
  {
    drivers: SYNC_MONGO_DRIVERS,
    id: 'pull-window-derived',
    title: 'the window W follows the server: 30 s on a standalone, the transaction lifetime plus 30 s on a replica set',
  },

  // --- resync (protocol §8) ------------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'resync-invalid',
    title: 'a tampered cursor, another model or another user answers 410 invalid',
  },
  { drivers: ALL, id: 'resync-horizon', title: 'a cursor older than the tombstone horizon answers 410 horizon' },
  { drivers: ALL, id: 'resync-access-roles', title: 'a changed role answers 410 access — for that user only' },
  {
    drivers: ALL,
    id: 'resync-access-scope',
    title: 'a scope field moved away from a user answers 410 access for that user, not for the others',
  },
  {
    drivers: ALL,
    id: 'resync-access-tenant',
    title: 'a removed membership and an invalidated tenant answer 410 access',
  },

  // --- push (protocol §6) --------------------------------------------------------------------------------------
  { drivers: ALL, id: 'push-create', title: 'a create with a client id is applied with version 1 and pulled' },
  {
    drivers: ALL,
    id: 'push-create-repeat',
    title: 'a repeated create: same mutation → the recorded outcome; another mutation → conflict, never a duplicate',
  },
  { drivers: ALL, id: 'push-update', title: 'a change on the current version is applied with the next version' },
  {
    drivers: ALL,
    id: 'push-conflict-reject',
    title: 'reject: a change on an old version answers conflict with the server record and changes nothing',
  },
  { drivers: ALL, id: 'push-strategy-lww', title: 'lww: a change on an old version is applied on top' },
  {
    drivers: ALL,
    id: 'push-strategy-merge',
    title: 'merge: the client\'s fields win, the server\'s other fields stay; a @SyncField("reject") field conflicts',
  },
  {
    drivers: ALL,
    id: 'push-strategy-custom',
    title: 'custom: the model service decides — its result is written, its refusal answers CUSTOM_REFUSED',
  },
  {
    drivers: ALL,
    id: 'push-delete',
    title: 'a delete leaves a tombstone; again → applied, upsert on it → conflict, without baseVersion → rejected',
  },
  {
    drivers: ALL,
    id: 'push-validation',
    title: 'invalid data is rejected with VALIDATION_FAILED, undeclared fields (version, createdBy) never land',
  },
  { drivers: ALL, id: 'push-invalid-id', title: 'an id in the wrong format is rejected with INVALID_ID' },
  {
    drivers: ALL,
    id: 'push-roles',
    title: 'without the operation roles an item is rejected with FORBIDDEN and nothing changes',
  },
  {
    drivers: ALL,
    id: 'push-without-pull-roles',
    title: 'a push answers with a record only to a caller who may pull it — never to one without the pull roles',
  },
  {
    drivers: ALL,
    id: 'push-items-independent',
    title: 'items apply in order, each on its own: a failing item does not undo another',
  },
  {
    drivers: ALL,
    id: 'push-body-invalid',
    title: 'a malformed body, an unknown op or too many items answer 400 before any item applies',
  },
  {
    drivers: ALL,
    id: 'push-two-tabs',
    title: 'the same push from two tabs at once makes one write — no duplicate, no false conflict',
  },
  {
    drivers: ALL,
    id: 'push-expired-session',
    title: 'an expired session answers 401 and applies nothing; the same items after sign-in apply once',
  },
  {
    drivers: ALL,
    id: 'push-cookie-origin',
    title: 'a cookie push needs JSON and a trusted origin; cross-site and a foreign Origin answer 403',
  },
  { drivers: ALL, id: 'push-api-token-refused', title: 'an API token is refused on the sync routes' },

  // --- tenants -------------------------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'tenant-pull-isolation',
    title: 'no record and no tombstone of another tenant in a pull — with and without X-Tenant-Id',
  },
  {
    drivers: ALL,
    id: 'tenant-push-foreign-id',
    title: 'an id of another tenant: create → ID_UNAVAILABLE, change/delete → not_found, the record unchanged',
  },
  {
    drivers: ALL,
    id: 'tenant-tombstone-scope',
    title: 'the tombstone of an owner-scoped record reaches its owner, not the rest of the tenant',
  },
  {
    drivers: ALL,
    id: 'push-create-without-tenant',
    title: 'a create on a tenant-scoped model needs X-Tenant-Id: rejected without it on every database, applied with it',
  },

  // --- concurrent writers --------------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'pull-during-writes',
    title: 'a client pulling while many writers change records at once receives every change in its final version',
  },

  // --- infrastructure stores (E7) ------------------------------------------------------------------------------
  {
    drivers: ALL,
    id: 'store-mutation-claim',
    title: 'a mutation claim: one of concurrent claimants wins, the others are busy, the outcome is recorded',
  },
  {
    drivers: ALL,
    id: 'store-mutation-takeover',
    title: 'an abandoned claim is taken over by exactly one, an expired entry counts as absent',
  },
  { drivers: ALL, id: 'store-epochs', title: 'concurrent epoch bumps all count, an unknown key is 0' },
  { drivers: ALL, id: 'store-horizon', title: 'the horizon only moves forward' },
];

export const SYNC_EXCLUSIONS: readonly SyncExclusion[] = [
  ...SYNC_MONGO_DRIVERS.map((driver) => ({
    case: 'pull-no-repeats',
    driver,
    provenBy: 'pull-window-repeats',
    reason:
      'DIFFERENT-BY-DESIGN: MongoDB orders changes by the server clock and every run re-reads the window W below its ' +
      'start (plan §3.4, P2-2) — repeats within W are the price of not losing a late commit',
  })),
  ...SYNC_SQL_DRIVERS.map((driver) => ({
    case: 'pull-window-repeats',
    driver,
    reason: 'IMPOSSIBLE: a SQL store numbers changes in commit order and has no window to repeat',
  })),
  ...SYNC_SQL_DRIVERS.map((driver) => ({
    case: 'pull-window-derived',
    driver,
    reason: 'IMPOSSIBLE: a SQL store numbers changes in commit order and derives no window',
  })),
];

export function getSyncCase(id: string): SyncCase {
  const found = SYNC_CASES.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`Unknown sync case '${id}'. Declare it in tests/helpers/sync-contract-matrix.ts.`);
  }
  return found;
}

export function getSyncExclusion(id: string, driver: SyncDriver): SyncExclusion | undefined {
  return SYNC_EXCLUSIONS.find((entry) => entry.case === id && entry.driver === driver);
}

/** Register a cell; a case not declared for the driver registers nothing (its exclusion says why) */
export function syncIt(id: string, driver: SyncDriver, body: () => Promise<void> | void, timeout?: number): void {
  const spec = getSyncCase(id);
  if (!spec.drivers.includes(driver)) {
    if (!getSyncExclusion(id, driver)) {
      throw new Error(`Sync case '${id}' is neither executed nor excluded for driver '${driver}'.`);
    }
    return;
  }
  it(spec.title, body, timeout);
}
