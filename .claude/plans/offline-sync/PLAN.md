# Offline sync — pull, push and tombstones on every database

> **Status:** planned 2026-10-29 against nest-server 12.1.0 (develop `e2f0a4a`), phase 1 of DEV-3819.
> **Linear:** epic DEV-3819; one ticket per phase: DEV-3898 (1, this plan + protocol), DEV-3899 (2, cursor prototype),
> DEV-3900 (3, DataStore extensions), DEV-3901 (4, sync module), DEV-3902 (5, hints + cleanup), DEV-3903 (6, test
> clients, browser E2E, docs, release). Worked one per `/lt-dev:ticket-cycle --autopilot` run.
> **Client contract:** `docs/offline-sync-protocol.md` (shipped with the package). This plan is the framework side: how
> the protocol is built on the `DataStore` port, in which order, and what still has to be measured.
> **Ideas, not code, from:** tag `archive/offline-sync-support` (`2273c94`, 11.25, deleted branch); §3.12 says what
> carries over.
> Read this file and the protocol completely before writing code.

---

## 1. Goal and objective function

DEV-3819: clients read and write offline and reconcile later — delta pull by cursor, push with conflict handling,
tombstones for deletions — for mobile, web/PWA and desktop/Node clients, **on every database and engine the server
supports with the same observable semantics**. A further database costs a contract run, never sync code of its own.

Priorities, in this order (inherited from DEV-3827):

1. **Security first.** Every pull and push runs through the existing pipeline (`process()`, `@Restricted`/`@Roles`,
   `securityCheck`, tenant policy before every store call, tenant row check after every read, RLS, interceptors). No
   lean path, no `store.native()`, no `store.raw()`.
2. **No lost and no duplicated change**, under several instances, skewed clocks, equal timestamps and late commits.
3. **Nothing changes without a sync configuration** — no field, index, route or code path.

## 2. Where 12.1.0 stands (measured 2026-10-29)

| Fact | Value | Where |
|---|---|---|
| Port | `DataStore<T>`: `count deleteById deleteMany deleteOne distinct find findById findOne insert native pullFromArray pushToArray raw sum updateById updateMany updateOne` | `common/persistence/data-store.interface.ts` |
| Atomic conditional change | `updateOne(where, update)` is atomic ("still matches when it is changed") on every store; `CrudService.update()` does not use it — it loads by id and writes back by id alone | same file; `sql/sql-data-store.ts` (`… WHERE id = (SELECT … FOR UPDATE) AND recheck`) |
| Capabilities | `changeFeed: false` and `transactions: false` on MongoDB, `changeFeed: false`, `transactions: true`, `rls: true` on PostgreSQL; `idType: 'objectId'` everywhere | `mongoose-data-store.ts`, `sql/sql-data-store.ts` |
| Id rule | `isWellFormedId()` = 24 hex; `generateId()` = ObjectId layout (timestamp, 5 process-random bytes, counter) | `common/persistence/id-format.ts` |
| Id column on SQL | PostgreSQL `text`, MySQL / MariaDB `varchar(255)` — wide enough for uuidv7 | `sql/postgres/postgres-schema.compiler.ts`, `sql/mysql/mysql-schema.compiler.ts` (primary key column) |
| Field kinds | `FieldKind` already has `uuid` | `model-descriptor.interface.ts` |
| Partial indexes | `IndexDescriptor.options.partialFilterExpression` is compiled natively on PostgreSQL (`… WHERE <filter>`). MySQL / MariaDB refuse a partial unique index except the sparse form (`UnsupportedQueryError`: "uniqueness would be checked nowhere"); they already emit VIRTUAL generated columns, today only as the null sentinel of a non-sparse unique index | same two compilers (index compilation) |
| Schema evolution | new optional/defaulted column and new index automatic; **changed uniqueness never automatic** (migration) | `.claude/plans/db-agnostic/PLAN.md` §3.12 |
| Infrastructure | `LockStore` (Mongo, PostgreSQL, MySQL), expiry sweep under a lease, `RateLimitStore` (memory/Redis), `CoreRedisPubSub`, WS re-check registry (`registerWsConnection`) | `common/persistence/`, `common/services/`, `common/helpers/graphql-ws-connection.helper.ts` |
| CSRF today | session cookie `SameSite=lax` + credentialed CORS for the trusted origins; Better-Auth sign-in/up forward Fetch-Metadata to Better-Auth's own check; Hub actions require `X-Hub-Request` | `common/helpers/cookies.helper.ts`, `modules/better-auth/core-better-auth.controller.ts` (`csrfCheckedRequest()`), `modules/hub/core-hub-actions.controller.ts` |
| SSE today | `POST /ai/stream` writes `text/event-stream` by hand | `modules/ai/core-ai.controller.ts` |
| Sync anywhere | none | — |

## 3. The design

### 3.1 The seam: a module on CrudService and the port

```
 /sync/{model} (controller)   syncHint (resolver)   /sync/hints (SSE)
                 │
 CoreSyncService ── per registered model: the project's CrudService (rights, securityCheck, output pipeline)
                 │                          conflict strategies, id/mutation handling, cursor codec
 DataStore (sync policies E1–E4 active for sync models only)      infrastructure stores (E7)
```

Pull calls the model's `CrudService` read with the caller's `ServiceOptions` and the store's change order (E4); push
calls its create/update/delete (a delete of a synchronized model leaves a tombstone, decided in phase 3). Differences between databases are asked through
`store.capabilities`, never through `store.driver`. The module never touches `native()` or `raw()`.

### 3.2 Model metadata

A model becomes syncable by declaration, read into its `ModelDescriptor` (the single source, db-agnostic §3.3):

```ts
@PersistedModel({
  sync: {
    strategy: 'reject',
    roles: { pull: [RoleEnum.S_USER], create: [RoleEnum.S_USER], update: [RoleEnum.ADMIN, RoleEnum.S_CREATOR],
             delete: [RoleEnum.ADMIN, RoleEnum.S_CREATOR] },
  },
})
export class Note extends CorePersistenceModel {
  @UnifiedField({ sync: 'lww' }) title?: string;     // per-field strategy for `merge`
}
```

**Operation roles are part of the declaration, because nothing else would carry them.** `CrudService` checks
operation roles only when the caller passes `serviceOptions.roles` (`common/helpers/input.helper.ts`, `check()` in
`process()`); a project restricts update and delete in its controller (the lt CLI's module template passes
`roles: [ADMIN, S_CREATOR]` there) and list or create with `@Roles` on its routes. None of that reaches `/sync`, and
field-level `@Restricted` is usually `S_EVERYONE` on generated fields — so without its own roles a sync push could
delete or overwrite any record the caller may read. `sync.roles` is passed as `serviceOptions.roles` on every
`CrudService` call of the module (so `S_CREATOR` / `S_SELF` are decided against the stored record, as everywhere), the
`delete` roles for a push `delete` (not the update rights), and the `pull` roles gate pull and both hint channels. An
operation without roles is open to `ADMIN` only; `sync: true` declares none, so the boot warns once per model until
roles are declared.

The descriptor gains a `sync` section: strategy, per-field strategies, operation roles, the model's id format (one, default `objectId`, §3.5), and the system
fields `version` (number, default 1), `deletedAt` (date, default `null`), the cursor field(s) chosen in phase 2, and
their indexes. On SQL these are new columns with defaults and new indexes — the automatic path of the schema evolution.
Unique indexes become partial (§3.6), which is **changed uniqueness** and therefore a migration for an existing model.

### 3.3 Port extensions (acceptance criterion 2)

Each extension is active **only** for models whose descriptor carries `sync`; every other model keeps today's behaviour
bit for bit. Cross-checked against `.claude/rules/persistence.md`.

| # | Extension | Why | `persistence.md` check |
|---|---|---|---|
| E1 | **Version policy**: `insert` sets `version: 1`; every write path (`updateById`, `updateOne`, `updateMany`, `pushToArray`, `pullFromArray`, upserts, soft delete) adds `$inc: { version: 1 }`, also with `UpdateOptions.timestamps: false`. **The conditional change goes through `CrudService`, not around it**: `CrudService.update()` today loads by id, merges and writes back by id alone (`updateById` on SQL, `findByIdAndUpdate` on MongoDB — `common/services/crud.service.ts`), so two pushes with the same `baseVersion` would both apply, and calling `store.updateOne()` directly would skip `process()` (operation roles, input `@Restricted`, `securityCheck`). Phase 3 adds a version condition to `ServiceOptions` (`expectedVersion`) that `update()` and `delete()` send inside `process()` as `dataStore.updateOne({ id, version: expected }, patch)` on SQL and `findOneAndUpdate({ _id, version: expected }, …)` on MongoDB; no match is a conflict. The write-back drops `version`, so `$inc` is the only operator on it. A contract case proves "two concurrent conditional changes, exactly one wins" at the `CrudService` level on every store, not only at the store level. | Optimistic lock must be one atomic statement (DEV-3819); a write path that forgets the increment makes a pull miss a change. | Neutral operators only (`$inc` + `$set` on different paths — MySQL and MongoDB refuse two operators on one path, so `version` is never part of the update — neither in `data` nor in the `CrudService.update()` write-back, which carries the stored record); policies live in the store, on MongoDB as policy functions the plugins call. |
| E2 | **Tombstone filter**: every read where gets `deletedAt: null` — the partial unique indexes' own filter (§3.6), because MongoDB uses a partial index only for a query that implies its filter. Phase 1 measured a `$type: 'null'` index (COLLSCAN for `null`, IXSCAN for `$type`); phase 2 measured the equality index on MongoDB 5.0, 7.0 and 8.2 (IXSCAN for `null`, COLLSCAN for `$type`) and chose it, because it also covers a document without the field. Filter and index always use the same form. On SQL it compiles to `IS NULL`. Applied to `find`, `findOne`, `findById`, `count`, `distinct`, `sum`, populate follow-up reads, and the matching part of `updateOne`/`updateMany`/`deleteOne`/`deleteMany` — unless the caller passes the explicit option `includeTombstones`, used only by the sync module — pull, and push for its conditional change, existence and visibility checks (an `upsert` on a tombstone must answer `conflict`, a repeated delete `applied`, a create on the caller's own deleted id `conflict`; filtered, all three would answer `not_found` and the client would drop its change) — and by the cleanup. | Tombstones must vanish from all normal reads (DEV-3819), including counts and populate; an update must not silently revive one. | On MongoDB the CrudService still reads through Mongoose documents (`mongoosePopulate`), so the filter is a policy function the Mongoose path applies too, like the tenant policy. Tier 2/3 (`native`, `raw`) bypass it by definition — documented, never used by sync. |
| E3 | **Partial unique indexes**: the descriptor of a sync model rewrites every unique index (field-level `unique` included) to apply to live records only. | Delete-then-recreate with the same unique value must not fail (DEV-3819). | MongoDB and PostgreSQL: the existing partial-index path. MySQL / MariaDB: **new compiler path** — the compiler refuses partial unique indexes today, so each part becomes a VIRTUAL live-key column (§3.6) next to the existing null-sentinel columns. Turning an existing unique index partial is changed uniqueness → `migrate create <name> --sql` / a MongoDB migration, never automatic. |
| E4 | **Change order**: a way to read "everything after cursor X, in change order, tombstones included", in pages. Decided in phase 2 (§3.4): on SQL a commit-ordered sequence `syncSeq` (counter row taken last, by trigger or by the transaction's final statement); on MongoDB `syncAt` from the server clock plus a window W. | The cursor must not lose changes (DEV-3819). | Must be expressible in the neutral query subset (`$gt`, sort, limit) or as a store method with one implementation per dialect and one contract suite; never `raw()`. |
| E5 | **Capabilities**: `idType` becomes per model (`idFormat: 'objectId' \| 'uuidv7'`, one per model, default `objectId`; §3.5). No `changeFeed` capability: hints come from the store's own write events on every database (P2-5, §11). | Sync asks capabilities, never the driver name (DEV-3819). | Capabilities exist for exactly this (db-agnostic §3.6). |
| E6 | **Client-supplied ids**: `insert({ id })` accepts the model's format for sync models (§3.5); MongoDB stores ObjectId-hex as ObjectId and uuidv7 as a BSON UUID (subtype 4). Validation `isWellFormedId()` stays the rule for every other model. A **server-generated** id that meets a duplicate key on a sync model is generated anew and the insert retried (bounded): `generateId()` and bson's ObjectId are predictable from one observed id (time, per-process value, counter), so a client could occupy the next ones and make every normal create on that process fail; a server id was never shown to anyone, so replacing it is invisible. | Clients create ids offline, in the model's format (decision 2026-10-29, §11). | Ids stay strings in the core (`generateId()`, `isObjectIdLike()`), no `new Types.ObjectId()` in the core. |
| E7 | **Infrastructure stores** (Mongo + SQL each, one contract suite): `SyncMutationStore` (claim, then outcome per `(model, id, mutationId)`, explicit `expiresAt`; §3.7), `SyncAccessEpochStore` (epoch per `(model, tenant)`, bump + read), tombstone retention horizon per model. Swept by the expiry sweep under the `LockStore` lease. | Idempotency, access-loss detection and the horizon must outlive a process and never depend on a TTL monitor (DEV-3819, db-agnostic §3.7). | "Never rely on a TTL monitor for correctness"; every reader checks the expiry itself. |
| E8 | **Tombstone purge**: `deleteMany({ deletedAt: { $lt: horizon } }, { includeTombstones: true })`, run by a cron job under a lease; advances the per-model horizon **before** deleting. | Bounded storage; a cursor older than the horizon must answer 410, never miss a deletion. | Hard delete stays internal; the horizon is written first so no pull can pass a gap. |

Not a port extension, by decision: a batch transaction. Push is item-atomic everywhere; `store.transaction(fn)` is
not used for batches (MongoDB standalone has no transactions, `capabilities.transactions` would split behaviour).

**Built in phase 3 (DEV-3900), every extension a case of the persistence matrix on all ten columns
(`tests/helpers/persistence-matrix.ts`, the `sync-*` cases):**

- **Declaration**: `@PersistedModel({ sync: true | { idFormat, scope } })`, read by `CorePersistenceModule.forFeature()`
  (`sync-model.ts`). Roles and conflict strategies join the same declaration with the module (DEV-3901). The descriptor
  gains `sync`, `version` and `deletedAt`; the change position is the dialect's own field (`syncSeq` on SQL through
  `withSequenceField()`, `syncAt` on MongoDB through the schema plugin). A TTL on a synchronized model is refused at
  registration — an expired record would vanish without a tombstone.
- **Deletes tombstone on every framework path**: `CrudService.delete()` and the port's `deleteById` / `deleteOne` /
  `deleteMany`. A hard delete through a normal route would reach no client. `DeleteOptions.hardDelete` (with
  `includeTombstones`) is the purge's primitive. A delete through the native model (tier 2/3) stays a hard delete.
- **Tombstone fields**: id, version, `deletedAt`, the change position, `tenantId`, the scope fields — and the audit and
  timestamp fields (`createdAt`, `updatedAt`, `createdBy`, `updatedBy`): the audit policy stamps the deleter on the
  same write, and clearing a field the same update sets is refused by MongoDB and MySQL.
- **E2 on MongoDB** is `mongo/sync-schema.plugin.ts`, applied to synchronized schemas only: every query hook adds
  `{ deletedAt: null }` with `$and` (a caller's own `deletedAt` condition stays), the aggregation hook a leading
  `$match` and one per join into a synchronized collection; `includeTombstones()` marks a query (a symbol on the query
  object, never a driver option). Replacements and pipeline updates are refused — neither can carry the increment.
- **MongoDB inserts keep `save()`** (every plugin's save hooks, the validation) and stamp `syncAt` with the server's
  clock read through `hello.localTime` and carried forward by the process's monotonic clock — not the upsert form
  considered in phase 2, which would bypass the save hooks of the tenant, audit, password and role plugins. Updates
  stamp with `$currentDate`, in the same operation. A save of a loaded document is conditional on its version
  (`$where`).
- **SQL change order**: the trigger numbers single-row writes; the store's multi-row writes (`updateMany`,
  `deleteMany`) lock their rows with `SELECT … FOR UPDATE`, then take their numbers, then set them explicitly in their
  final statement — rows first, numbers last, without the sentinel round trip (the trigger keeps a value the statement
  sets itself). PostgreSQL takes the numbers under the model's advisory lock from a sequence (measured, §5), MySQL and
  MariaDB from the counter row. Store inserts use the trigger form: the wait on an uncommitted duplicate is bounded by
  a one-statement transaction. Rows a table holds when it becomes synchronized are numbered at the schema change.
- **Ids**: `capabilities.idType` is the model's format, `capabilities.changeOrder` (`seq` / `clock`) is present for a
  synchronized model only. A client id in the wrong format is refused (400) rather than replaced; a server id that is
  taken is generated anew, three attempts.
- **Without `sync`** a model keeps every behaviour bit for bit (`sync-model-unaffected`, the full suite).

### 3.4 Cursor (candidates measured in phase 2, decision below)

The old cursor `{ updatedAt, _id }` loses changes: app clocks differ between instances, timestamps collide, and on
PostgreSQL / MySQL a transaction that commits after a younger change was pulled lands behind the client's cursor. The
candidates:

| | C1 — change sequence + commit horizon | C2 — database-clock timestamp + overlap window |
|---|---|---|
| Write | every write to a sync model stores `syncSeq` from a per-source sequence (PostgreSQL / MySQL sequence or auto-increment counter table, MongoDB counter document) | every write stores `syncAt` from the **database** clock (`now()`, `CURRENT_TIMESTAMP(6)`, `$$NOW` in an update pipeline) — one clock per database, so app clocks do not matter |
| Pull | `syncSeq > cursor AND syncSeq <= horizon`, ordered by `syncSeq`; horizon = highest value below which no in-flight write can still commit (PostgreSQL: record `pg_current_xact_id()` and bound by `pg_snapshot_xmin(pg_current_snapshot())`) | ordered by `(syncAt, id)` and continued strictly by keyset, `(syncAt, id) > (pos.at, pos.id)`; the overlap is a separate cursor field, a low-water mark that only moves forward (the run's read time minus `W`), so a run re-reads the window once, not on every page. A page-wise `syncAt >= cursor.at − W` would return the same first page forever once more than `limit` records share the window — certain when a model becomes syncable, because one backfill statement gives every row the same database time. Client keeps the higher `version` of repeats |
| Guarantee rests on | an exact horizon per database | every write committing within `W` of its timestamp — bounded by the framework's one-transaction-per-store-operation rule (db-agnostic §3.8) plus an enforced statement/transaction timeout `< W` |
| Duplicates | none | records changed within `W` before the cursor come again |
| Weak spot | MySQL / MariaDB have no snapshot-horizon API; MongoDB's counter and record write are two operations (an in-flight gap needs a horizon too) | `W` must hold under load; a write slower than `W` (timeout not enforced, clock step on the database host) is lost |
| Port | E4 as a store method per dialect | E4 expressible in the neutral subset plus the clock source per dialect |

C3 combines them behind one opaque, versioned cursor format: C1 where an exact horizon is cheap (PostgreSQL), C2
elsewhere. **Phase 2 measures, per database/engine/topology** (MongoDB standalone and replica set, PostgreSQL ×
TypeORM / Kysely / Drizzle, MySQL 8.4, MariaDB 11.8): lost changes with two and more app instances writing in parallel,
app clocks skewed by ±5 s, equal timestamps, and deliberately late commits (a transaction held open); **progress**: more
than `maxLimit` records with one identical timestamp and a burst larger than `maxLimit` within `W` — every run must end
with `hasMore: false`; duplicates per page; pull latency for 10k / 100k records; write overhead. **Gate:** zero lost
changes and a terminating run on every target, or stop and report.

**Decided in phase 2 (DEV-3899, measurements in §5): C3, one mechanism per database family.**

* **SQL — PostgreSQL × three engines, MySQL 8.4, MariaDB 11.8: a commit-ordered change sequence, counter taken
  last (C1d).** One counter row per sync model (`lt_sync_counters`). A `BEFORE INSERT OR UPDATE` row trigger bumps it
  and stamps `sync_seq`; the trigger runs after the row lock, so a write takes its row first and the counter last. A
  statement that writes several rows of a sync model, and a transaction with more than one statement, write their rows
  with the sentinel `sync_seq = -1` (the trigger leaves it alone) and take the counter with their final statement
  before COMMIT, after every row lock they need. The counter's row lock is held until COMMIT, so sequence order is
  commit order: `sync_seq > cursor ORDER BY sync_seq` can never pass a number that commits later. No horizon, no
  window, no clock, no duplicates. The trigger also numbers writes that bypass the store (tier 2/3, migrations) —
  with one exception to "counter last": a statement that writes **several** rows without the sentinel takes the
  counter at its first row and only then locks the rest, the order rejected for C1, so it can deadlock with store
  writes (MySQL / MariaDB roll back the smaller transaction, usually the store's). Multi-row writes outside the store
  (data migrations, the backfill that makes a model syncable) therefore use the sentinel form too, built into
  `runSqlMigration()`. Likewise an `INSERT` through the trigger takes the counter before its unique check, so a wait
  on an uncommitted duplicate holds it; phase 3 decides whether store inserts use the deferred form for that reason.
  The price is a per-model serialization point: writes to one sync model wait for each other's final statement and commit
  (measured ~3,100 writes/s on PostgreSQL against ~8,500 without a counter, §5). One counter per model is what was
  measured. A counter per (model, tenant) would lift the ceiling per tenant, but only together with a cursor that
  keeps one position per tenant of the pull's scope, or with pulls restricted to one tenant: a pull without
  `X-Tenant-Id` spans every membership, and one position over several independent sequences skips changes. Phase 3
  decides that with its own contract case (a header-less pull over two tenants).
  **PostgreSQL keeps a version per counter update.** One row updated per write leaves one dead version each; a long
  snapshot anywhere in the database (`pg_dump`, a long report, an idle-in-transaction session, a replication slot,
  `hot_standby_feedback`) keeps them all, and every later update walks past them — the write ceiling falls with write
  rate × snapshot age, the same coupling to other sessions that rules out C1x, measured here only on 15 s runs. A final
  statement over N rows must therefore bump the counter once (`seq = seq + N`, rows stamped `base + row_number`) rather
  than N times in one transaction, which is quadratic. Phase 3 measures the alternative that writes no row versions —
  `pg_advisory_xact_lock(<model>)` plus a sequence, which keeps commit order because the lock is released only after
  the commit is visible — against the counter row under a held snapshot. MySQL and MariaDB update in place.
* **MongoDB — standalone and replica set: the server clock with a window (C2).** Every write path stamps
  `syncAt: '$$NOW'` (one operation, the server's clock); pull by keyset `(syncAt, _id)`, and each run starts once
  from its low-water mark, the previous run's start minus W, measured on the server's clock. The store has no
  multi-document transactions (`capabilities.transactions: false`), so a framework write is visible when its operation
  returns; W must still cover a transaction opened by project code on a replica set, so it is derived from
  `transactionLifetimeLimitSeconds` (default 60 s) with margin, and sync writes carry a `maxTimeMS` below W. A run
  repeats what changed within W (P2-2: yes, on MongoDB); clients keep the higher `version` either way. Measured: with
  the server's limit below W, the server aborted every transaction held past it and nothing was lost (§5).
  **The window is a cost:** each run re-reads the R·W records changed within W however little is new, and a client
  pulling every Δ seconds receives each change about W/Δ times, every copy through the output pipeline (no lean pull) —
  2 changes/s, W = 60 s and one pull per second are 120 records per pull for about 2 that are new. So W is sized per
  topology: a standalone has no transactions, and its W covers the operation bound (`maxTimeMS`) plus a clock-step
  margin; a replica set needs the transaction-lifetime W only because project code could write a sync model in a
  transaction, and phase 3 decides whether to refuse that instead. §5 measured W = 5 s.

Rejected, each with its measurement in §5:

| Candidate | Why not |
|---|---|
| C0 (archived cursor: app clock + id) | loses on every target |
| C1n (plain sequence, no horizon) | allocation order is not commit order: loses on every SQL target |
| C1 (counter bumped first) | exact, but holds the counter for the whole transaction: under late commits writes collapse to single digits per second, MySQL runs into lock-wait timeouts, and mixed with row-first writes it deadlocks |
| C1t alone (trigger, no deferral) | the trigger fires at the first write of a transaction (and at the first row of a multi-row statement), so a long transaction holds the counter like C1 — it is C1d's single-row path, not a design of its own |
| C1x (PostgreSQL `xid8` below `pg_snapshot_xmin`) | exact and without write serialization (~2.8× C1d's write rate, §5), but PostgreSQL only, and its horizon is cluster-wide: any open writing transaction in any database of the server — another project's batch job, an idle-in-transaction session, a forgotten prepared transaction — holds every pull back until it ends; on a cluster several projects share, that couples their availability. One mechanism for PostgreSQL and MySQL is worth more; C1x stays the measured fallback should a project hit the counter's ceiling |
| C2 on SQL | loses whenever a commit lags its stamp by more than W, and neither MySQL nor MariaDB bounds a transaction's lifetime on the server; MySQL / MariaDB `NOW(6)` stamps the statement **start**, so a lock wait alone exceeds W (measured: lost changes with transactions open ≤ 2 s at W = 5 s) |
| C1 on MongoDB | standalone has no transactions, counter and write are two operations, and the gap loses changes even without late commits; on a replica set the counter document in a transaction is exact but write conflicts throttle every writer of the model |

**Consequences for the port (E4, phase 3):** SQL — `sync_seq bigint` + index, the counter table and one trigger per
sync table from the schema compiler (as the owner, a changed trigger body is a schema change the migrator detects), the
store's multi-row and transaction paths with the sentinel, the pull as `{ syncSeq: { $gt } }` + sort + limit in the
neutral subset; the application role needs `UPDATE` on the counter table on PostgreSQL (MySQL triggers run with the
definer's rights). MongoDB — `syncAt: '$$NOW'` on every write path (pipeline update), and an insert that still fails
on a taken id: a plain upsert would update the existing document instead and break E6 and the protocol's `conflict` /
`ID_UNAVAILABLE`, so phase 3 uses a form that can only insert (an upsert whose filter cannot match, to be verified)
and pins it with a contract case — a create on a taken id leaves the stored record unchanged; index
`{ syncAt: 1, _id: 1 }`, the run start from the server clock (`hello.localTime` from 4.4 on; `$documents` with `$$NOW`
needs 5.1), W from `getParameter` with a configured fallback where the parameter cannot be read; the keyset pull in the
neutral subset. **Indexes on a tenant-scoped sync model lead with the tenant**: `(tenant_id, sync_seq)` and
`{ tenantId: 1, syncAt: 1, _id: 1 }` — every pull there carries the tenant policy's `tenantId` condition (`=` or `$in`),
and an index without it either scans every tenant's changes since the cursor or sorts the tenant's whole set per page
(§5's latencies come from tables without a tenant column); a contract case checks the plan (`explain()`, documents
examined). The cursor names its mechanism (`seq` / `clock`); a cursor of another mechanism or source — a model
moved between databases — is answered like an expired one (full resync).

The cursor is serialized as `base64url(JSON { v, model, pos, fp, epoch, iat })` plus an HMAC over it (key from the
server's secrets), so it stays opaque, cannot be edited into another user's or model's cursor, and is refused as
`invalid` when tampered with. For MongoDB `pos` carries the run's low-water mark and start, so a cursor stored in the
middle of a run resumes that run, and the next run after its last page starts from the run start minus W.

### 3.5 Identifiers

**One format per model, never mixed** (owner, 2026-10-29, §11): ObjectId-hex stays the default for every model —
existing models and projects change nothing, and a sync model with ObjectIds lets clients generate them, as MongoDB's
own drivers do. uuidv7 is a per-model choice for **new** models only; on MongoDB it is stored as a BSON UUID (binary
subtype 4), on SQL as text, and the core keeps ids as strings (the store converts at its boundary, like ObjectId).
Every other model keeps ObjectId-hex only. The protocol §3 states the client rules. Collision with an invisible record →
uniform `ID_UNAVAILABLE`, ids unique across tenants (decided O2, §11): the one observable bit carries no tenant, owner or
content. Hardening: rights on every access, the uniform answer plus the push rate limit, a server id occupied by a
client is generated anew (E6), and client ids are unpredictable in either format — uuidv7 by construction, a client's
ObjectId with 8 secure random bytes after its timestamp (protocol §3). A driver's default ObjectId would let a member
who saw one of a client's ids create its next ones first; the server cannot detect the generator, so the rule is the
client's and the phase 6 test clients follow it. A uuidv7 validator joins `id-format.ts` beside
`isWellFormedId()` (version nibble `7`, variant `8–b`, lowercase). The former P2-3 (ObjectId and string `_id` side by
side) cannot arise and was dropped.

### 3.6 Tombstones and unique indexes

Live records store `deletedAt: null`. The live filter is the equality `{ deletedAt: null }`, measured in phase 2
(P2-4, `prototypes/partial-unique.mjs`, MongoDB 5.0.31, 7.0, 8.2): MongoDB accepts it as a `partialFilterExpression`,
it covers a document whose field is `null` **or missing** (so making an existing model syncable needs no backfill), and
a query `{ …, deletedAt: null }` uses the index. Phase 1's `{ deletedAt: { $type: 'null' } }` works too but leaves a
document without the field out of the index (a duplicate then passes) and is used only by a `$type` query — so the
read filter (E2) and the index filter must be the same form, and the equality is the one that also compiles to
`IS NULL` on SQL. PostgreSQL: `… NULLS NOT DISTINCT WHERE deleted_at IS NULL` — the `NULLS NOT DISTINCT` is
load-bearing: the compiler drops it today for every partial unique index (`postgres-schema.compiler.ts`, `nulls =
unique && !conditions.length`), and measured, a second live `NULL` then passes on PostgreSQL where MongoDB refuses it. MySQL / MariaDB have no partial index and the compiler refuses one today; each part of a
unique index becomes a VIRTUAL column `IF(deleted_at IS NULL, IFNULL(<field>, <sentinel>), NULL)` (the sentinel is the
one the existing null-sentinel columns use, so a live `NULL` still collides like on MongoDB; a sparse unique index
leaves it out) and the unique index spans
those columns — a tombstone yields `NULL` in every part, and MySQL lets `NULL` repeat. A tombstone keeps `id`, `version`,
`deletedAt`, `updatedAt`, the cursor field(s), `tenantId` and the `syncScope` user-id fields (decided O1, §11 — so the
tombstone reaches exactly the users who could see the record); every content field is cleared in the same atomic update
(on SQL set to `NULL`, on MongoDB `$unset`). This needs no schema change: on SQL every column but `id` is nullable (the database never enforces `required`, validation does —
`sql/postgres/postgres-schema.compiler.ts`), and MongoDB runs no update validators; only the input validators must not
apply to the tombstone write. **Measured in phase 2 (P2-4, §5):** on every target a second live value and a second live
`NULL` are refused and tombstones may repeat a live value; on MySQL / MariaDB reviving a tombstone whose value is live
again is refused. DEV-3900 turns this into a matrix case on all ten columns.

### 3.7 Idempotency, horizon, rate limits

* **Creates** are idempotent through the client id: a repeated create of an id the caller may see answers `conflict`
  with the record as the caller's output pipeline shows it — never a comparison with `data`. An answer that depended on
  stored values would be an oracle: with a fresh `mutationId` per item, a caller could push a known record with guesses
  for a field `@Restricted` hides from them and read the value off the one `applied` (100 guesses per request).
* **Changes** carry a `mutationId`, and the mutation store is written **before** the record (claim first): an insert of
  `(model, id, mutationId)` under a unique key with `{ state: 'pending', claimedAt }`. After the write the claim becomes
  the terminal `{ status, version }`, kept for `retention.mutationsDays` (default 30). A repeat that finds a terminal
  entry answers with it; one that finds a pending claim younger than the claim timeout answers `retry` — that is how two
  tabs sending the same change at once end in one write and no false conflict, which a record written after the write
  cannot give (both requests would miss it, one would win the conditional change, the other report a conflict). A
  pending claim older than the timeout (the process died between claim and record) is taken over with a conditional
  update on `claimedAt`; the takeover's write then meets either an untouched record or its own effect.
* **Own effect** (a taken-over claim whose first write did land, or a repeat after the retention): a version mismatch,
  decided by the strategy — `reject` answers `conflict` with the server record, which already contains the change;
  `lww` writes the same values again (same content, one more version); `merge` answers `merged`. Never a duplicate
  record.
* **Horizon:** per model, the oldest point a cursor may continue from; advanced by the purge (E8) before it deletes.
* **Rate limits:** the existing `RateLimitStore` (memory / Redis), one namespace for pull, one for push, per user.

### 3.8 Access loss → full resync

Decision 2026-10-29: a full resync — for the client that lost access, and only for it. Two checks, split by who an event
concerns:

* **The caller's own access** is `fp`, a hash of (user id, tenant scope, global roles, membership role, verification
  state) taken when the cursor is issued and recomputed on every pull. A removed membership, a changed role or a
  revoked verification changes it, and that user's next pull answers 410 `access`. These per-user events —
  `CoreTenantGuard.invalidateUser()`, `CoreUserService.setRoles()`, role / verification updates — bump **no** shared
  epoch: a bump per (model, tenant) would send every other member into a full resync for one person's change (one
  invitation into a 500-member tenant: 500 resyncs of every sync model).
* **Access that moves with a record** is the `SyncAccessEpochStore` epoch, carried in the cursor. Per (model, tenant):
  bumped by `invalidateTenant()` and by a write that moves a sync record to another tenant. Per (model, tenant, user)
  for a field the model declares as `syncScope`, which must hold a user id (owner, assignee): a write that changes the
  field away from a user bumps that user's epoch, so only cursors issued to that user answer 410. A `syncScope` of
  another shape (team, project) is not supported until it is decided.

A per-record removal signal may follow later.

### 3.9 Hints

SSE `GET /sync/hints` (core) and the GraphQL subscription `syncHint` carry `{ model, at }` only. Source: the CrudService
emits after every successful write of a sync model, in process or through `CoreRedisPubSub` across replicas — on every
database, no change feed (P2-5, decided in phase 2, §11). Delivery is filtered per subscriber by the
tenant of the change and the subscriber's read right on the model; bursts are debounced. Both channels are long-lived:
they register with the connection registry like `registerWsConnection()` and are re-checked on invalidation and every
`subscriptionRevalidationMs` (`.claude/rules/role-system.md` → "Open WebSockets": a guard asked once is not enough for
a connection that outlives the answer).

### 3.10 Configuration (presence implies enabled)

```ts
sync: {
  path: 'sync',
  pull: { defaultLimit: 200, maxLimit: 1000, maxBytes: 1_048_576 },
  push: { maxItems: 100 },
  retention: { tombstonesDays: 90, mutationsDays: 30 },
  hints: { sse: true, graphql: true, debounceMs: 250 },
  rateLimit: { pull: { max: 120, windowSeconds: 60 }, push: { max: 60, windowSeconds: 60 } },
}
```

Absent → nothing registered (no route, no policy, no schema change). Models opt in through their metadata (§3.2); a
model routed to a source whose store lacks a capability sync needs fails the boot with a named error.

### 3.11 Security mapping

| Rule (DEV-3819) | Mechanism |
|---|---|
| Full pipeline, no lean path | pull/push call the model's `CrudService` with the caller's `ServiceOptions` |
| Operation rights | `sync.roles` per operation as `serviceOptions.roles`, deny by default (ADMIN only) — route `@Roles` and controller-passed roles do not reach `/sync` (§3.2) |
| Hidden fields | no answer depends on a value the caller may not read (repeated create: always `conflict`, §3.7) |
| Server ids | a server id a client occupied is replaced, never a failed create (E6) |
| Tenant | tenant policy before every store call, row check after every read, RLS on PostgreSQL — unchanged; tombstones carry `tenantId` and pass the same filter |
| Foreign ids | update/delete: `not_found` exactly like a missing id; create: `ID_UNAVAILABLE` (decided O2) |
| Tombstone content | cleared on delete; pull returns the system fields plus the `syncScope` user ids it is filtered by (decided O1) |
| No hard delete | push `delete` goes through `CrudService.delete()`, which tombstones a synchronized model on every path (phase 3); the purge is internal (`hardDelete`) |
| Cookie push | SameSite=lax + CORS + `Content-Type: application/json` + Origin / `Sec-Fetch-Site` check (protocol §4) |
| API tokens | refused unless the project releases a sync scope (`@ApiTokenScopes`) |
| Long-lived hint channels | registered and re-checked (§3.9) |
| Device data | the integration checklist says what a client deletes on logout (phase 6) |

### 3.12 What the archived branch contributes

Carried over as ideas: the three layers (schema, service, transport), `expectedVersion` → `baseVersion`, soft delete
through the normal update pipeline, conflict strategies per field (there `@SyncField`, here `@UnifiedField({ sync })`, §3.2), per-leg toggles, hint debounce, the
`not_found` answer for invisible records. **Not** carried over: the Mongoose plugin and schema option, TTL indexes for
idempotency and tombstones, server-assigned ids with 24-hour idempotency keys, the `{ updatedAt, _id }` cursor,
`pullLean`, GraphQL-only hints (DEV-3819 "Was am alten Konzept nicht trägt").

## 4. Phases

Every phase: TDD, `pnpm run check` green, test count never drops, every behaviour fix pinned by a registered mutation,
review, one squash-merged PR into `develop`. Phases 3–5 change **nothing** for a project without a sync configuration
(the unchanged suite is the proof).

### Phase 1 — Protocol and port operations (DEV-3898)
1. `docs/offline-sync-protocol.md`: the client contract, every DEV-3819 requirement traced (§14 there).
2. This plan: port extensions E1–E8 with reasons and the `persistence.md` check, cursor candidates, phases, open
   questions.

### Phase 2 — Cursor prototype on every target database (DEV-3899)
1. Prototype scripts under `.claude/plans/offline-sync/prototypes/` (like db-agnostic's), each runnable against the test
   containers; the MongoDB **replica set** was a throwaway container (`mongo:7.0`, one node) and joins the test
   infrastructure with phase 3, where matrix cases need it.
2. C1 and C2 (and C3 where it applies) on MongoDB standalone and replica set, PostgreSQL × three engines, MySQL,
   MariaDB, with the scenarios of §3.4; numbers recorded in §5.
3. Answers P2-1 … P2-5 (protocol §15); the decision goes into §11 and the protocol's OPEN markers are resolved.
4. Gate: zero lost changes everywhere, or stop and report.

### Phase 3 — DataStore extensions (DEV-3900)
1. Descriptor `sync` section from `@PersistedModel({ sync })` / `@UnifiedField({ sync })`, both description sources
   (`persistence-model-descriptor.spec.ts`).
2. E1 version policy (incl. `expectedVersion` through `CrudService.update()`), E2 tombstone filter (incl. the Mongoose-document path), E3 partial unique indexes (descriptor
   rewrite; migration hint for existing models), E4 change order as decided, E5 capabilities, E6 client ids — each with
   persistence-parity matrix cases on all ten columns.
3. ~~E7 infrastructure stores; E8 purge op.~~ Moved in phase 3 (DEV-3900): E7 to DEV-3901, whose idempotency and
   access epochs are their first consumers; E8 to DEV-3902 with the purge cron. The port already has the purge's
   primitive (`DeleteOptions.hardDelete` with `includeTombstones`).
4. Gate: a project without sync configuration is unchanged (full suite, mutations); matrix green on every column.

### Phase 4 — Sync module (DEV-3901)
1. `src/core/modules/sync/` per `.claude/rules/core-modules.md` (module inheritance, `Core*` classes, overrides,
   `autoRegister`), config interface, `docs/offline-sync-protocol.md` linked from its README.
2. Pull (pages by count and size, cursor codec with HMAC, resume), push (item-atomic, conflict strategies, client ids,
   mutation idempotency, 401 before any item), resync (horizon, access epoch, invalid), error codes, rate limits,
   cookie-push origin rule, API token scopes.
3. Epoch bumps wired into the tenant guard invalidations, `setRoles()`, role/verification updates, scope moves.
4. Contract suite on MongoDB standalone, replica set, PostgreSQL × three engines, MySQL, MariaDB; tenant suite (no
   foreign record or tombstone in a pull, foreign ids refused without revealing them); multi-instance test with skewed
   clocks.

### Phase 5 — Hints and cleanup (DEV-3902)
1. SSE endpoint and GraphQL subscription, store-emitted hints via in-process / Redis pub/sub (no change feed, P2-5),
   debounce, per-subscriber filtering, registration + re-check of the long-lived channels.
2. Tombstone purge cron under a `LockStore` lease (horizon first), mutation-store sweep through the expiry sweep.

### Phase 6 — Test clients, browser E2E, docs, release (DEV-3903)
1. Minimal PWA test client (IndexedDB) driven by Playwright with offline emulation: create/change/delete offline,
   reconnect, conflict, two tabs, expired session, cleared storage.
2. Node client with SQLite passing the same scenarios against the same API.
3. Module README, INTEGRATION-CHECKLIST (incl. what a client deletes on logout), SECURITY, migration guide, configurable
   features row, `REQUEST-LIFECYCLE.md`; release.

## 5. Validated assumptions

Measured 2026-10-31 (DEV-3899) with `prototypes/` (how to run them: its README) on the test containers — PostgreSQL
18.6, MySQL 8.4.10, MariaDB 11.8.8 — the local MongoDB 8.2.3 standalone and a one-node MongoDB 7.0 replica set; SQL
through the framework's own executors (`dist/`), so the three PostgreSQL engines run their own transaction paths.

**Setup of a concurrent run** (`cursor-lab.mjs`): 15 s on a fresh table; three app instances, each its own process and
pool with its own clock (0, +5 s, −5 s), 4 write loops each (12 in the late scenarios); 50 % inserts, 40 % updates,
10 % tombstones, 30 % of updates and tombstones on five hot records; two clients pull run after run all along (pages of
25 and 100) and twice more over the same cursor after the writers stopped. **Lost** = a record whose client version is
below its final database version, tombstones included, summed over both clients. W = 5 s in the prototype.
`late`: 15 % of the transactions stay open 0.2–2 s after their write; `beyond W`: 10 % stay open 6–8 s.

| Assumption | Result |
|---|---|
| The harness detects losses (negative controls) | C0 loses 66–77 % of the records per client on every target it ran on; C1n 15–19 % under late commits and 0.01–0.11 % without them on every SQL target; MongoDB standalone C1 (counter and write as two operations) loses in every scenario (up to 17 %) |
| **A commit-ordered counter taken last loses nothing (C1d, SQL)** | **0 lost in all 30 concurrent runs on the five SQL targets** (late and beyond W, 3 runs each), and in the `parallel` run of each. C1d's late transactions wait before they take the counter; that a counter held until COMMIT keeps sequence order equal to commit order is shown by C1 and C1t, which hold it through the wait (0 lost in every run) |
| Taking the counter first is exact but stalls (C1, C1t) | 0 lost, but 5–7 writes/s under late commits and 1–3 beyond W, where C1d keeps 94–108 and 18–26 (means); MySQL / MariaDB ran into lock-wait timeouts (`retries`). The first C1d draft, which mixed C1's counter-first single writes with row-first deferred writes, deadlocked (14 retries in one 6 s run on MariaDB) — the reason C1d takes the counter last on every store path, and multi-row writes outside the store use the sentinel too (§3.4) |
| The PostgreSQL horizon is exact (C1x) | 0 lost on all three engines, late and beyond W |
| The database clock with W is exact while commits lag less than W (C2) | 0 lost on PostgreSQL × 3 and MongoDB in `late`; **lost on MySQL** in `late` (2 in run 3: a hot record, final version 50, client 45); lost on every target with transactions held open beyond W; MongoDB standalone cannot hold a write open, so it has no late case |
| **W derived from the server's transaction limit makes C2 exact on MongoDB** | replica set with `transactionLifetimeLimitSeconds: 3`, W = 5 s, transactions held 6–8 s, writes without retry (`MONGO_TXN_NO_RETRY=1`): the server aborted every one of them (83–91 failed commits per run, none committed late), **0 lost in 3 runs** |
| Why MySQL loses with commits below W | `commit-lag-probe.mjs`: with a 3 s row-lock wait, MySQL / MariaDB `NOW(6)` stamps the statement start (commit − stamp ≈ 3,000 ms), `SYSDATE(6)` and PostgreSQL `clock_timestamp()` the moment after the wait (≈ 2 ms), PostgreSQL `now()` the transaction start |
| A run terminates with equal keys (progress) | 500 records with one identical key (one backfill statement, one `$$NOW`): every variant on every target delivers all 500 in 21 pages of 25 / 6 pages of 100; C2's next run re-reads the 500 (the window) and terminates too. No non-terminating run in any scenario; the longest run had 17,768 pages (MongoDB standalone C2 at ~35,000 writes/s) |
| **PostgreSQL: the counter row slows under a held snapshot, the advisory lock does not** (phase 3, `prototypes/pg-counter-snapshot.mjs`, 8 writers, 30 % inserts, 60 s per run) | without a held snapshot the counter row keeps ~5,400 writes/s, advisory lock + sequence ~6,300; with a REPEATABLE READ snapshot held open elsewhere the counter row falls steadily from 5,209 to 2,616 writes/s within the minute (every update walks the versions the snapshot keeps alive), advisory lock + sequence stays at ~5,900. Both numbered every write once (distinct `sync_seq` = rows) |
| The counter costs write throughput (C1d) | one counter per model serializes its writes for the final statement and the commit: PostgreSQL ~3,100 writes/s against ~8,500 for C0 / C1x, MySQL 1,075 against 3,777, MariaDB 12,332 against 14,961 (12 writers, local containers, one 10 s run). On a disk where a commit waits for its flush, a counter allows about one commit per flush. Ways out, both for phase 3 to decide (§3.4): a counter per (model, tenant) with a cursor position per tenant, or C1x on PostgreSQL |
| A counter on MongoDB is not viable (C1) | standalone loses (above); replica set in a transaction: exact, but 728 writes/s with 7,663 write-conflict retries against C2's 5,328 in the same setup, and 1–7 writes/s under late commits |

**Lost changes, three runs per cell, `late` (writes/s, mean, in brackets):**

| Variant | mongo-standalone | mongo-rs | pg-typeorm | pg-kysely | pg-drizzle | mysql | mariadb |
|---|---|---|---|---|---|---|---|
| C0 | 2547 · 2417 · 2222 (190/s) | 1422 · 1641 · 1795 (108/s) | 1553 · 1445 · 1259 (99/s) | — | — | 1665 · 1660 · 1686 (129/s) | 1277 · 1737 · 1154 (100/s) |
| C1n | — | — | 365 · 296 · 253 (108/s) | — | — | 351 · 377 · 320 (121/s) | 301 · 319 · 338 (92/s) |
| C1 | 494 · 535 · 568 (181/s) | 0 · 0 · 0 (6/s) | 0 · 0 · 0 (7/s) | — | — | 0 · 0 · 0 (6/s) | 0 · 0 · 0 (6/s) |
| C1t | — | — | 0 · 0 · 0 (5/s) | — | — | 0 · 0 · 0 (6/s) | 0 · 0 · 0 (6/s) |
| **C1d** | — | — | **0 · 0 · 0** (108/s) | **0 · 0 · 0** (94/s) | **0 · 0 · 0** (105/s) | **0 · 0 · 0** (100/s) | **0 · 0 · 0** (105/s) |
| C1x | — | — | 0 · 0 · 0 (119/s) | 0 · 0 · 0 (95/s) | 0 · 0 · 0 (102/s) | — | — |
| **C2** | **0 · 0 · 0** (no late case) | **0 · 0 · 0** (117/s) | 0 · 0 · 0 (115/s) | 0 · 0 · 0 (113/s) | 0 · 0 · 0 (96/s) | 0 · 0 · 2 (101/s) | 0 · 0 · 0 (104/s) |

**Lost changes, `beyond W` (transactions open 6–8 s, W = 5 s):**

| Variant | mongo-standalone | mongo-rs | pg-typeorm | pg-kysely | pg-drizzle | mysql | mariadb |
|---|---|---|---|---|---|---|---|
| C1 | 132 · 140 · 154 (49/s) | 0 · 0 · 0 (2/s) | 0 · 0 · 0 (3/s) | — | — | 0 · 0 · 0 (1/s) | 0 · 0 · 0 (1/s) |
| C1t | — | — | 0 · 0 · 0 (1/s) | — | — | 0 · 0 · 0 (1/s) | 0 · 0 · 0 (1/s) |
| **C1d** | — | — | **0 · 0 · 0** (24/s) | **0 · 0 · 0** (21/s) | **0 · 0 · 0** (23/s) | **0 · 0 · 0** (26/s) | **0 · 0 · 0** (18/s) |
| C1x | — | — | 0 · 0 · 0 (20/s) | 0 · 0 · 0 (17/s) | 0 · 0 · 0 (19/s) | — | — |
| C2 | 0 · 0 · 0 (no late case) | 94 · 78 · 82 (21/s) | 40 · 78 · 78 (14/s) | 60 · 74 · 72 (16/s) | 76 · 58 · 88 (16/s) | 96 · 64 · 84 (24/s) | 94 · 82 · 88 (21/s) |
| **C2, server limit 3 s < W** | — | **0 · 0 · 0** (32/s) | — | — | — | — | — |

**Write throughput without late commits** (`parallel`, one 10 s run; lost in that run, writes/s in brackets):

| Variant | mongo-standalone | mongo-rs | pg-typeorm | pg-kysely | pg-drizzle | mysql | mariadb |
|---|---|---|---|---|---|---|---|
| C0 | 357,676 (52,228/s) | 37,782 (5,478/s) | 58,756 (8,605/s) | — | — | 26,026 (3,777/s) | 104,309 (14,961/s) |
| C1n | — | — | 15 (7,785/s) | — | — | 20 (2,347/s) | 27 (5,470/s) |
| C1 | 77 (22,825/s) | 0 (728/s) | 0 (2,870/s) | — | — | 0 (522/s) | 0 (2,352/s) |
| C1t | — | — | 0 (2,969/s) | — | — | 0 (1,051/s) | 0 (11,686/s) |
| **C1d** | — | — | **0** (3,004/s) | **0** (3,126/s) | **0** (3,093/s) | **0** (1,075/s) | **0** (12,332/s) |
| C1x | — | — | 0 (8,461/s) | 0 (8,544/s) | 0 (8,604/s) | — | — |
| **C2** | **0** (40,615/s) | **0** (5,328/s) | 0 (6,202/s) | 0 (7,442/s) | 0 (7,703/s) | 0 (4,616/s) | 0 (12,257/s) |

**Pull latency** (`volume`: one client, pages of 500, then 200 changes and one incremental run; full pull of 10k / 100k
records in ms). C2's incremental run re-reads every record because all of them were written within W before it.

| Target | C1d (SQL) / C1 (MongoDB) | C2 | C2 incremental (records re-read) |
|---|---|---|---|
| pg-typeorm | 19 / 175 | 15 / 179 | 142 ms (99,800) |
| pg-kysely | 23 / 170 | 17 / 172 | 140 ms (99,800) |
| pg-drizzle | 18 / 172 | 14 / 155 | 135 ms (99,800) |
| mysql | 44 / 510 | 65 / 604 | 511 ms (99,800) |
| mariadb | 21 / 276 | 27 / 214 | 231 ms (99,800) |
| mongo-standalone | 25 / 217 | 29 / 263 | 212 ms (99,800) |
| mongo-rs | 30 / 290 | 32 / 343 | 320 ms (99,800) |

An incremental C1d run after 200 changes took 1 ms on every SQL target, without a repeated record.

**P2-4** (`partial-unique.mjs`, MongoDB 5.0.31 / 7.0 / 8.2.3, PostgreSQL 18.6, MySQL 8.4.10, MariaDB 11.8.8): every target
refuses a second live value and a second live `NULL` and accepts tombstones repeating a live value; MySQL / MariaDB
refuse reviving a tombstone whose value is live again. PostgreSQL without `NULLS NOT DISTINCT` accepts the second live
`NULL`. MongoDB accepts `partialFilterExpression: { deletedAt: null }` on all three versions; it indexes a document
whose field is `null` or missing (two documents without the field and the same value collide) and `{ …, deletedAt: null }`
uses it (IXSCAN) while `$type: 'null'` does not (COLLSCAN) — the reverse of a `$type` index.

**What this does not prove** — left to the phase 3 contract cases: a replica set with several members (failover, clock
difference between members; W covers a clock step smaller than W); C1d's path for one statement over many rows, and
multi-row writes outside the store racing store writes (measured: single-row writes and long transactions);
PostgreSQL's counter row under a held snapshot; the MySQL / MariaDB store path, which wraps a write in a transaction
with a read-back, so it holds the counter at least one round trip longer than the autocommitted statement measured
here; per-tenant counters; tenant-prefixed pull indexes on a table with
many tenants; `$currentDate` as an alternative to `$$NOW`; commit latencies of a real disk and a network instead of
local containers.

## 6. Gates and abort criteria

* **After phase 2:** a cursor mechanism with zero lost changes on every target database and topology. Otherwise stop
  and report — a sync that loses changes on one database is worse than none.
* **Phases 3–5 must not change a project without sync configuration.** An existing test that has to be edited (not
  extended) to stay green is a stop-and-explain.
* **A capability a target cannot provide** is declared IMPOSSIBLE in the matrix with a reason and refused at boot for a
  sync model routed there — never left out silently.

## 7. Non-negotiable constraints

1. Only the `DataStore` port and the neutral query language; differences through `store.capabilities`; no
   `native()`, `raw()`, driver or engine name checks in sync code.
2. Every write path increments `version` on a sync model; a path that cannot is refused for sync models.
3. Security pipeline on every pull and push; no lean path.
4. No TTL index carries correctness; every expiring record is checked by its reader.
5. ESM / vendor rules of `src/core/` (`.claude/rules/architecture.md` → "Module Format"); DI tokens in leaves.
6. `pnpm run check` green after every step; regression tests carry `@regression` + `@seen-failing`.

## 8. Downstream (follow-up tickets, not part of this epic)

* `nuxt-extensions`: offline-sync composable for Nuxt PWAs (decision 2026-10-29).
* `nuxt-base-starter`: example page that works offline, with a service worker.
* lt-dev: review rules for sync models (backend and frontend reviewers).

## 9. Effort (rough, new + touched LOC)

Phase 2 ~1,500 (prototypes, infra) · Phase 3 ~3,000 · Phase 4 ~3,500 · Phase 5 ~1,500 · Phase 6 ~2,500.

## 10. Open questions

Phase 3 settled what phase 2 left (§11): one counter per model, the advisory lock on PostgreSQL, the trigger form for
inserts, transactions on synchronized models not refused, the MongoDB insert form. Left to DEV-3901, where the pull is
built: the margin of W over MongoDB's transaction lifetime (and whether a transaction can still commit between its
limit and the server's reaper run). Left to DEV-3902: a `runSqlMigration()` helper that numbers a data migration's
multi-row writes on a synchronized table the way the store does — until then such a migration locks its rows, takes
the numbers and sets `sync_seq` itself, or runs while nothing else writes the table.

## 11. Decisions

**Owner, 2026-10-29 (DEV-3819):** client ids ObjectId-hex **and** uuidv7; access loss → full resync; hints over SSE in
the core plus GraphQL subscription; documented protocol plus test clients (PWA, Node + SQLite), the Nuxt composable as
a follow-up in `nuxt-extensions`; the cursor decided by the prototype; no pilot project.

**Owner, 2026-10-29 (DEV-3898):** O1 — a tombstone keeps the `syncScope` user-id fields (e.g. `ownerId`), only user ids,
never content; without them it reaches either the whole tenant or nobody. O2 — the uniform `ID_UNAVAILABLE` stays and
ids stay unique across tenants; ids unique per tenant would change every lookup, reference and route by id. The id
answer should be as safe as possible; how ObjectId and uuidv7 coexist (P2-3) is weighed with that in mind.

**Owner, 2026-10-29 (DEV-3899, decision comment from the DEV-3898 review):** ids — ObjectId-hex stays the default for
every model, one format per model and never mixed, uuidv7 a per-model choice for new models only (MongoDB: BSON UUID,
binary subtype 4; SQL: text); the hardening (rights on every access, uniform `ID_UNAVAILABLE` + rate limit, server ids
regenerated on collision) holds for either format. P2-3 dropped.

**Phase 3, autopilot (DEV-3900, recorded on the ticket):** E1–E6 here, E7 to DEV-3901, E8 to DEV-3902 (§4). A delete of
a synchronized model leaves a tombstone on every framework path; the module's push `delete` goes through
`CrudService.delete()` with `expectedVersion` (the delete roles, not the update roles, and `deletedAt` stays a system
field). PostgreSQL numbers changes with `pg_advisory_xact_lock` plus a sequence instead of the counter row (§5); MySQL
and MariaDB keep the counter row. One counter per model. MongoDB inserts keep `save()` and stamp the server clock read
through `hello.localTime`. Transactions on synchronized models are not refused. A tombstone also keeps the audit and
timestamp fields. Details: §3.3, "Built in phase 3".

**Phase 2, autopilot (DEV-3899, measured — §5, recorded on the ticket):** P2-1 — the cursor is C3 per database family:
on SQL a commit-ordered sequence with the counter taken last (C1d), on MongoDB the server clock with a window W derived
from the transaction lifetime (C2), §3.4. P2-2 — a pull repeats unchanged records on MongoDB (within W), never on SQL.
P2-4 — the MongoDB live filter is `{ deletedAt: null }` (replaces phase 1's `$type: 'null'`), PostgreSQL keeps
`NULLS NOT DISTINCT` with the live condition (the compiler drops it for partial unique indexes today — a parity gap for
existing partial unique indexes too, handed to phase 3, whose E3 rewrites this path), MySQL / MariaDB use the virtual
live-key column (§3.6). P2-5 — no change feed; hints come from the store's write events on every database (§3.9).
From the phase 2 review: a client generates ObjectId-hex ids with 8 secure random bytes after the timestamp (protocol
§3) — a driver's default ObjectId lets a member who saw one of a client's ids take its next ones first; and a
per-tenant counter is not decided, because it needs a cursor position per tenant (§3.4).

**Phase 1, autopilot (DEV-3898, recorded as assumptions on the ticket):** protocol in `docs/` rather than
`src/core/modules/sync/` (a directory there is listed as a core module by the FRAMEWORK-API generator before the module
exists); `mutationId` idempotency in an infrastructure store with explicit expiry; access fingerprint + per-(model,
tenant) epoch in the cursor; cookie push additionally requires JSON and a trusted Origin; the conditional change uses
the existing atomic `updateOne`, reached through `CrudService.update()` (`expectedVersion`, E1); live records carry `deletedAt: null` for partial unique indexes; hint channels are
re-checked like WebSockets; API tokens refused on sync routes by default.
