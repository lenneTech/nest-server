import { createSchema } from '../../common/persistence/mongo/mongoose-compat.js';

/**
 * The sync module's infrastructure stores (offline-sync plan §3.3 E7, §3.7) as framework models: registered with
 * `CorePersistenceModule.forFeature()`, they follow `database` like every other model and run through one code path
 * on every database — a collection on MongoDB, a table on SQL. Nothing here relies on the TTL for correctness: every
 * reader checks `expiresAt` itself; MongoDB's TTL index and the SQL expiry sweep only reclaim the space.
 */

/**
 * One pushed mutation per `key` (model, user, record, mutation id — hashed): claimed before the record is written
 * (`state: 'pending'`), then its outcome (`state: 'done'` with `status`, `version`, `code`). `attempt` makes every
 * takeover a conditional write that exactly one request wins.
 */
export const SyncMutationSchema = createSchema(
  {
    attempt: { type: Number },
    claimedAt: { type: Date },
    code: { type: String },
    expiresAt: { index: { expireAfterSeconds: 0 }, type: Date },
    key: { index: { unique: true }, type: String },
    state: { type: String },
    status: { type: String },
    version: { type: Number },
  },
  { collection: 'syncMutations', versionKey: false },
);

/**
 * Access epochs (`epoch:…` keys, an integer bumped when access to synchronized records changes, plan §3.8) and tombstone
 * horizons (`horizon:<model>`, the oldest point a cursor may continue from, advanced by the purge before it deletes).
 */
export const SyncStateSchema = createSchema(
  {
    epoch: { type: Number },
    horizon: { type: Date },
    key: { index: { unique: true }, type: String },
  },
  { collection: 'syncStates', versionKey: false },
);
