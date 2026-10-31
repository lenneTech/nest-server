/**
 * Constants of the sync module (offline sync, `docs/offline-sync-protocol.md`). Import-free leaf: tokens and numbers
 * only, so every file of the module may import it without an import cycle.
 */

/** The framework model holding one entry per pushed mutation (claim, then outcome; protocol §6.5) */
export const SYNC_MUTATION_MODEL = 'SyncMutation';

/** The framework model holding the access epochs and the tombstone horizons (plan §3.7, §3.8) */
export const SYNC_STATE_MODEL = 'SyncState';

/** Metadata of `@SyncService()` on a project's CrudService class */
export const SYNC_SERVICE_METADATA = 'lt:sync:service';

/** Metadata of `@SyncField()`: field name → strategy, on the model class */
export const SYNC_FIELD_METADATA = 'lt:sync:fields';

/**
 * A mutation claimed this recently is still being written (protocol §6.5): a repeat answers `retry`. An older claim
 * belongs to a request that died between the claim and its outcome, and is taken over.
 */
export const SYNC_CLAIM_TIMEOUT_MS = 30_000;

/** How often a write applied on top of the current state (`lww`, `merge`, `custom`) is tried before `retry` */
export const SYNC_REAPPLY_ATTEMPTS = 3;

/** Defaults of the `sync` configuration (plan §3.10) */
export const SYNC_DEFAULTS = Object.freeze({
  hintDebounceMs: 250,
  maxBytes: 1_048_576,
  maxItems: 100,
  maxLimit: 1000,
  mutationsDays: 30,
  path: 'sync',
  pullLimit: 200,
  rateLimitPull: { max: 120, windowSeconds: 60 },
  rateLimitPush: { max: 60, windowSeconds: 60 },
  tombstonesDays: 90,
});

/** How often the tombstone purge runs (on one replica per run, under a lease; plan §3.7, E8) */
/** Tombstones per purge statement: small enough that a statement never holds many row locks at once */
export const SYNC_PURGE_BATCH = 1000;

export const SYNC_PURGE_INTERVAL_MS = 60 * 60_000;

/** How often an open hint stream sends a comment, so proxies and load balancers keep it open */
export const SYNC_HINT_KEEPALIVE_MS = 25_000;

/** The hard upper bound of `sync.pull.maxLimit` (protocol §5.1) */
export const SYNC_PULL_LIMIT_CEILING = 1000;
