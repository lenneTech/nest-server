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
calls its create/update (soft delete = an update setting `deletedAt`). Differences between databases are asked through
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

The descriptor gains a `sync` section: strategy, per-field strategies, operation roles, accepted id formats (both), and the system
fields `version` (number, default 1), `deletedAt` (date, default `null`), the cursor field(s) chosen in phase 2, and
their indexes. On SQL these are new columns with defaults and new indexes — the automatic path of the schema evolution.
Unique indexes become partial (§3.6), which is **changed uniqueness** and therefore a migration for an existing model.

### 3.3 Port extensions (acceptance criterion 2)

Each extension is active **only** for models whose descriptor carries `sync`; every other model keeps today's behaviour
bit for bit. Cross-checked against `.claude/rules/persistence.md`.

| # | Extension | Why | `persistence.md` check |
|---|---|---|---|
| E1 | **Version policy**: `insert` sets `version: 1`; every write path (`updateById`, `updateOne`, `updateMany`, `pushToArray`, `pullFromArray`, upserts, soft delete) adds `$inc: { version: 1 }`, also with `UpdateOptions.timestamps: false`. **The conditional change goes through `CrudService`, not around it**: `CrudService.update()` today loads by id, merges and writes back by id alone (`updateById` on SQL, `findByIdAndUpdate` on MongoDB — `common/services/crud.service.ts`), so two pushes with the same `baseVersion` would both apply, and calling `store.updateOne()` directly would skip `process()` (operation roles, input `@Restricted`, `securityCheck`). Phase 3 adds a version condition to `ServiceOptions` (`expectedVersion`) that `update()` — and a delete through `update()` — sends inside `process()` as `dataStore.updateOne({ id, version: expected }, patch)` on SQL and `findOneAndUpdate({ _id, version: expected }, …)` on MongoDB; no match is a conflict. The write-back drops `version`, so `$inc` is the only operator on it. A contract case proves "two concurrent conditional changes, exactly one wins" at the `CrudService` level on every store, not only at the store level. | Optimistic lock must be one atomic statement (DEV-3819); a write path that forgets the increment makes a pull miss a change. | Neutral operators only (`$inc` + `$set` on different paths — MySQL and MongoDB refuse two operators on one path, so `version` is never part of the update — neither in `data` nor in the `CrudService.update()` write-back, which carries the stored record); policies live in the store, on MongoDB as policy functions the plugins call. |
| E2 | **Tombstone filter**: every read where gets `deletedAt: { $type: 'null' }` — the partial unique indexes' own filter (§3.6), because MongoDB uses a partial index only for a query that implies its filter, and `deletedAt: null` (which also matches a missing field) does not: a lookup by a unique field then scans the whole collection (measured on MongoDB 8.2 with 20k documents: COLLSCAN for `null` and `$eq: null`, IXSCAN for `$type: 'null'`). On SQL both compile to `IS NULL`. Applied to `find`, `findOne`, `findById`, `count`, `distinct`, `sum`, populate follow-up reads, and the matching part of `updateOne`/`updateMany`/`deleteOne`/`deleteMany` — unless the caller passes the explicit option `includeTombstones`, used only by the sync module — pull, and push for its conditional change, existence and visibility checks (an `upsert` on a tombstone must answer `conflict`, a repeated delete `applied`, a create on the caller's own deleted id `conflict`; filtered, all three would answer `not_found` and the client would drop its change) — and by the cleanup. | Tombstones must vanish from all normal reads (DEV-3819), including counts and populate; an update must not silently revive one. | On MongoDB the CrudService still reads through Mongoose documents (`mongoosePopulate`), so the filter is a policy function the Mongoose path applies too, like the tenant policy. Tier 2/3 (`native`, `raw`) bypass it by definition — documented, never used by sync. |
| E3 | **Partial unique indexes**: the descriptor of a sync model rewrites every unique index (field-level `unique` included) to apply to live records only. | Delete-then-recreate with the same unique value must not fail (DEV-3819). | MongoDB and PostgreSQL: the existing partial-index path. MySQL / MariaDB: **new compiler path** — the compiler refuses partial unique indexes today, so each part becomes a VIRTUAL live-key column (§3.6) next to the existing null-sentinel columns. Turning an existing unique index partial is changed uniqueness → `migrate create <name> --sql` / a MongoDB migration, never automatic. |
| E4 | **Change order**: a way to read "everything after cursor X, in change order, tombstones included", in pages. Shape depends on phase 2 (§3.4): a store-assigned sequence field plus a commit-horizon read, or a timestamp field set from the database clock plus an overlap window. | The cursor must not lose changes (DEV-3819). | Must be expressible in the neutral query subset (`$gt`, sort, limit) or as a store method with one implementation per dialect and one contract suite; never `raw()`. |
| E5 | **Capabilities**: `idType` becomes per model (`idFormats: ['objectId', 'uuidv7']` for sync models); `changeFeed` tells the truth per topology (MongoDB replica set: change streams; PostgreSQL: `LISTEN/NOTIFY`; standalone MongoDB, MySQL: false). | Sync asks capabilities, never the driver name (DEV-3819). | Capabilities exist for exactly this (db-agnostic §3.6). |
| E6 | **Client-supplied ids**: `insert({ id })` accepts both formats for sync models; MongoDB stores ObjectId-hex as ObjectId and uuidv7 as a string `_id`, decided by the format alone. Validation `isWellFormedId()` stays the rule for every other model. A **server-generated** id that meets a duplicate key on a sync model is generated anew and the insert retried (bounded): `generateId()` and bson's ObjectId are predictable from one observed id (time, per-process value, counter), so a client could occupy the next ones and make every normal create on that process fail; a server id was never shown to anyone, so replacing it is invisible. | Clients create ids offline; both formats (decision 2026-10-29). | Ids stay strings in the core (`generateId()`, `isObjectIdLike()`), no `new Types.ObjectId()` in the core. |
| E7 | **Infrastructure stores** (Mongo + SQL each, one contract suite): `SyncMutationStore` (claim, then outcome per `(model, id, mutationId)`, explicit `expiresAt`; §3.7), `SyncAccessEpochStore` (epoch per `(model, tenant)`, bump + read), tombstone retention horizon per model. Swept by the expiry sweep under the `LockStore` lease. | Idempotency, access-loss detection and the horizon must outlive a process and never depend on a TTL monitor (DEV-3819, db-agnostic §3.7). | "Never rely on a TTL monitor for correctness"; every reader checks the expiry itself. |
| E8 | **Tombstone purge**: `deleteMany({ deletedAt: { $lt: horizon } }, { includeTombstones: true })`, run by a cron job under a lease; advances the per-model horizon **before** deleting. | Bounded storage; a cursor older than the horizon must answer 410, never miss a deletion. | Hard delete stays internal; the horizon is written first so no pull can pass a gap. |

Not a port extension, by decision: a batch transaction. Push is item-atomic everywhere; `store.transaction(fn)` is
not used for batches (MongoDB standalone has no transactions, `capabilities.transactions` would split behaviour).

### 3.4 Cursor candidates (measured in phase 2)

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

The cursor is serialized as `base64url(JSON { v, model, pos, fp, epoch, iat })` plus an HMAC over it (key from the
server's secrets), so it stays opaque, cannot be edited into another user's or model's cursor, and is refused as
`invalid` when tampered with.

### 3.5 Identifiers

Both formats for sync models (decision 2026-10-29); every other model keeps ObjectId-hex only. The protocol §3 states
the client rules. Collision with an invisible record → uniform `ID_UNAVAILABLE`; the remaining observable bit and the
per-tenant alternative are open question O2 (§10). A uuidv7 validator joins `id-format.ts` beside `isWellFormedId()`
(version nibble `7`, variant `8–b`, lowercase).

### 3.6 Tombstones and unique indexes

Live records store `deletedAt: null` (never "absent"): MongoDB's `partialFilterExpression` accepts `$exists: true` but
not `$exists: false`, so the live filter is `{ deletedAt: { $type: 'null' } }` — a document without the field is in
no such index, so the migration that makes an existing model syncable also backfills `deletedAt: null`. PostgreSQL:
`… WHERE deleted_at IS NULL`. MySQL / MariaDB have no partial index and the compiler refuses one today; each part of a
unique index becomes a VIRTUAL column `IF(deleted_at IS NULL, IFNULL(<field>, <sentinel>), NULL)` (the sentinel is the
one the existing null-sentinel columns use, so a live `NULL` still collides like on MongoDB; a sparse unique index
leaves it out) and the unique index spans
those columns — a tombstone yields `NULL` in every part, and MySQL lets `NULL` repeat. A tombstone keeps `id`, `version`,
`deletedAt`, `updatedAt`, the cursor field(s) and `tenantId`; every content field is cleared in the same atomic update
(on SQL set to `NULL`, on MongoDB `$unset`). This needs no schema change: on SQL every column but `id` is nullable (the database never enforces `required`, validation does —
`sql/postgres/postgres-schema.compiler.ts`), and MongoDB runs no update validators; only the input validators must not
apply to the tombstone write. **OPEN (P2-4):** verified as a contract case in phase 2.

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
emits after every successful write of a sync model, in process or through `CoreRedisPubSub` across replicas; a
`changeFeed` capability is used where phase 2 shows it is worth it (P2-5). Delivery is filtered per subscriber by the
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
| Foreign ids | update/delete: `not_found` exactly like a missing id; create: `ID_UNAVAILABLE` (O2) |
| Tombstone content | cleared on delete; pull returns only the system fields (O1 for per-user visibility) |
| No hard delete | push `delete` is a soft delete through `update()`; the purge is internal |
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
   containers; a MongoDB **replica set** container joins the test infrastructure for this.
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
3. E7 infrastructure stores (Mongo + PostgreSQL + MySQL) with one contract suite each; E8 purge op.
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
1. SSE endpoint and GraphQL subscription, CrudService-emitted hints via in-process / Redis pub/sub, `changeFeed` where
   phase 2 recommends it, debounce, per-subscriber filtering, registration + re-check of the long-lived channels.
2. Tombstone purge cron under a `LockStore` lease (horizon first), mutation-store sweep through the expiry sweep.

### Phase 6 — Test clients, browser E2E, docs, release (DEV-3903)
1. Minimal PWA test client (IndexedDB) driven by Playwright with offline emulation: create/change/delete offline,
   reconnect, conflict, two tabs, expired session, cleared storage.
2. Node client with SQLite passing the same scenarios against the same API.
3. Module README, INTEGRATION-CHECKLIST (incl. what a client deletes on logout), SECURITY, migration guide, configurable
   features row, `REQUEST-LIFECYCLE.md`; release.

## 5. Validated assumptions

Empty until phase 2 records its measurements here (scripts in `prototypes/`, one row per assumption: what was measured,
on which targets, result).

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

The protocol's §15 is the list (P2-1 … P2-5 for phase 2, O1 and O2 for the owner before phase 4). Resolved entries
move to §11 with date and reason.

## 11. Decisions

**Owner, 2026-10-29 (DEV-3819):** client ids ObjectId-hex **and** uuidv7; access loss → full resync; hints over SSE in
the core plus GraphQL subscription; documented protocol plus test clients (PWA, Node + SQLite), the Nuxt composable as
a follow-up in `nuxt-extensions`; the cursor decided by the prototype; no pilot project.

**Phase 1, autopilot (DEV-3898, recorded as assumptions on the ticket):** protocol in `docs/` rather than
`src/core/modules/sync/` (a directory there is listed as a core module by the FRAMEWORK-API generator before the module
exists); `mutationId` idempotency in an infrastructure store with explicit expiry; access fingerprint + per-(model,
tenant) epoch in the cursor; cookie push additionally requires JSON and a trusted Origin; the conditional change uses
the existing atomic `updateOne`; live records carry `deletedAt: null` for partial unique indexes; hint channels are
re-checked like WebSockets; API tokens refused on sync routes by default.
