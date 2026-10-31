# Sync (offline sync)

Clients read and write while offline and reconcile with the server afterwards: they **pull** what changed since their
cursor, **push** what they changed locally, and receive **tombstones** for deletions. The client contract is the
protocol in [`docs/offline-sync-protocol.md`](../../../../docs/offline-sync-protocol.md) — a client needs `fetch` and
nothing from this package. This module is the server side, on every database the framework supports (MongoDB
standalone and replica set, PostgreSQL with TypeORM, Kysely or Drizzle, MySQL, MariaDB), with the same observable
behaviour.

Integration steps: [`INTEGRATION-CHECKLIST.md`](./INTEGRATION-CHECKLIST.md). Reference implementation:
[`src/server/modules/sync-note/`](../../../server/modules/sync-note/).

## What it adds

| Route                                | Protocol |                                                            |
| ------------------------------------ | -------- | ---------------------------------------------------------- |
| `GET /sync/{model}?cursor=…&limit=…` | §5       | One page of changes after the cursor, tombstones included  |
| `POST /sync/{model}`                 | §6       | Apply `{ items: [...] }` item by item, one result per item |
| `GET /sync/hints?models=…`           | §9       | SSE: `event: change` with `{ model, at }` — pull now       |
| `subscription { syncHint(models) }`  | §9       | The same hints over GraphQL (where GraphQL is enabled)     |

Nothing without the `sync` configuration: no route, no infrastructure model, no listener on the write paths.

## Configuration (`sync`, presence implies enabled)

```typescript
sync: {
  cursorSecret: process.env.SYNC_CURSOR_SECRET,  // else SECRETS_ENCRYPTION_KEY; REQUIRED in production / staging
  path: 'sync',
  pull: { defaultLimit: 200, maxLimit: 1000, maxBytes: 1_048_576, windowSeconds: undefined /* MongoDB, derived */ },
  push: { maxItems: 100 },
  hints: { debounceMs: 250, sse: true, graphql: true },  // false: both channels off
  retention: { mutationsDays: 30, tombstonesDays: 90 },  // tombstonesDays: false keeps them for ever
  rateLimit: { pull: { max: 120, windowSeconds: 60 }, push: { max: 60, windowSeconds: 60 } },  // false: off
}
```

`true` or `{}` enables it with these defaults. The full reference: `ISync` in
`common/interfaces/server-options.interface.ts`.

## Offering a model

Two declarations, both explicit — a model is never offered by accident:

1. **The model** — `@PersistedModel({ sync: { roles, strategy, scope, idFormat } })`. This makes it a synchronized
   model in the data store (version, tombstones, live-only unique indexes, change order — see
   `.claude/rules/persistence.md` → "Synchronized models") and carries what the sync routes need:
   - `roles` per operation (`pull`, `create`, `update`, `delete`). The roles a project puts on its own routes do **not**
     reach `/sync`; an operation without roles is open to `ADMIN` only, and the boot warns until they are declared. They
     are passed as `serviceOptions.roles`, so `S_CREATOR` / `S_SELF` are decided against the stored record.
   - `strategy`: `reject` (default), `lww`, `merge` (field by field; `@SyncField('reject')` marks a field that still
     conflicts), `custom` (the service's `resolveSyncConflict()`).
   - `scope`: the user-id fields a tombstone keeps (e.g. `['ownerId']`), so a deletion reaches exactly its users.
2. **The service** — `@SyncService({ model, createInput, updateInput })` on the model's `CrudService`. Every pull and
   push runs through that service; `data` is validated and whitelisted against the inputs like a request body.

The model must be registered with `CorePersistenceModule.forFeature()`.

## Security model

| Rule                            | How                                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The full pipeline, no lean path | Pull reads through the service's `find()` (`process()`, output `@Restricted`, tenant policy, RLS) and runs every record through `securityCheck()`; push writes through `create()` / `update()` / `delete()` |
| Operation rights                | The model's `sync.roles`, deny by default (ADMIN only)                                                                                                                                                      |
| Hidden fields                   | No answer depends on a value the caller may not read: a repeated create is always `conflict` with the record as the caller sees it, never compared with `data`                                              |
| Foreign ids                     | Change / delete: `not_found`, exactly like a missing id. Create: `ID_UNAVAILABLE` — the same answer for every reason an id cannot be used                                                                   |
| No hard delete                  | Push `delete` goes through `CrudService.delete()`, which tombstones a synchronized model on every path                                                                                                      |
| Tombstones                      | Carry id, version, `deletedAt`, `updatedAt`, `tenantId` and the scope fields the caller may see — no content                                                                                                |
| Cursor                          | Opaque, HMAC-signed, bound to model and user; another user's, another model's or a tampered cursor is `410 invalid`                                                                                         |
| Access loss                     | A fingerprint of the caller's access (user, tenant scope, roles, membership role, verification) and access epochs travel in the cursor; a change answers `410 access`, the client resyncs in full           |
| Cookie push                     | `Content-Type: application/json`; while the server uses cookies, `Sec-Fetch-Site: cross-site` and an untrusted `Origin` answer 403                                                                          |
| API tokens                      | Refused like on every route without `@ApiTokenScopes()` (see "Extending")                                                                                                                                   |
| Session expired                 | 401 for the whole request before any item; the client resends the same items, mutation ids recognise them                                                                                                   |

A pull or push without `X-Tenant-Id` spans every tenant the caller belongs to (the tenant guard's membership logic);
writes to a tenant-scoped model need the header, as everywhere — a create without it is `rejected` / `FORBIDDEN` on
every database, because nothing could tell which of the caller's tenants the record belongs to. A pull without it reads
each of the caller's tenants on its own and merges them in change order, so the tenant-led change index serves every
page.

What a client must do on its side — delete its local data on logout and on an account switch, keep credentials out of
reach of injected scripts, cache no API responses — is in [SECURITY.md](./SECURITY.md).

## Clients

The protocol needs `fetch` and nothing from the server's code (`docs/offline-sync-protocol.md`). Two test clients in
the framework repository prove it end to end against the reference server, with one shared protocol implementation
(`tests/clients/sync-client.mjs`, not part of the package):

| Client                                                                                       | Storage                | Suite                                |
| -------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------ |
| PWA in Chrome, served by the test server, service worker for offline loading, session cookie | IndexedDB              | `tests/sync-pwa-client.e2e-spec.ts`  |
| Node, as a desktop or React Native app would be, bearer session token                        | SQLite (`node:sqlite`) | `tests/sync-node-client.e2e-spec.ts` |

Both pass the same scenarios (`tests/helpers/sync-client-scenarios.ts`): create, change and delete offline, then online;
a conflict; two tabs pushing at once; a session that expired while offline; cleared storage. Two server processes with
clocks 10 s apart lose no change under parallel writers (`tests/sync-clock-skew.e2e-spec.ts`). A Nuxt composable for
projects follows in `@lenne.tech/nuxt-extensions`.

## Idempotency and repeats

Every item carries a `mutationId`. The module **claims** it before the write (model, user, record, mutation id —
hashed, unique), records the outcome afterwards and answers a repeat with that outcome for `retention.mutationsDays`.
A repeat that finds a claim still being written answers `retry` — that is how two tabs sending the same push end in one
write and no false conflict. A claim older than 30 s belongs to a request that died and is taken over.

## Change order and windows

The store decides how changes are ordered (`capabilities.changeOrder`): on SQL a commit-ordered sequence (`syncSeq`) —
no repeats; on MongoDB the server clock (`syncAt`) with a window W below each run's start — records changed within W
are delivered again, clients keep the higher `version`. W is derived: replica set or sharded cluster — the server's
`transactionLifetimeLimitSeconds` (60 when unreadable) + 30 s; standalone — 30 s. `sync.pull.windowSeconds` overrides
it; it must cover the longest time a write can take from its stamp until it is visible.

## Hints

A hint tells a connected client that pulling is worthwhile; sync works without them (protocol §9).

- **Source:** every successful `create()` / `update()` / `delete()` of the model's `CrudService` — on every database,
  no change feed. A write past it (the data store, the native API, a migration) calls
  `CoreSyncService.notifyChange(model, tenantIds)`, or clients learn of it at their next pull.
- **Content:** `{ model, at }` only. **Recipients:** callers with the model's pull roles and, on a tenant-scoped model,
  only for changes in their own tenants (the validated `X-Tenant-Id`, without it every membership). `models` narrows a
  channel; a name that is not offered never matches and reveals nothing.
- **Bursts:** one hint per model and tenant per `hints.debounceMs`, already at the sender. **Replicas:** with `redis`
  every replica receives every hint through one channel and delivers it to its own subscribers; without Redis a hint
  stays on its replica.
- **Long-lived channels are re-checked:** the GraphQL subscription runs on the WebSocket `CoreModule` re-checks; an SSE
  stream is registered in the same registry and ends at once on an invalidation naming the caller or their tenant, and
  otherwise before the first hint after `graphQl.subscriptionRevalidationMs` — the EventSource reconnects (`retry`) and
  the new request passes the guards. A client pulls once after every (re)connect.

## Tombstone purge

Every hour, on one replica (a lease: Redis, else the SQL lease table, else `cron-locks` in MongoDB), each model's
horizon moves to `retention.tombstonesDays` ago **first**, then the older tombstones are deleted for good. A client
whose cursor is older than the horizon answers its next pull with `410 horizon` and resyncs; nothing is skipped.
The tombstones go in batches of 1000, read by id and deleted by id: one statement over the whole table would lock
every row it scans on MySQL / MariaDB and hold up every write of the model.
`CoreSyncService.purgeTombstones({ before?, model? })` runs it on demand.

## Data migrations on a synchronized SQL table

A multi-row write in a migration goes through `runSqlMigration()` as a `syncUpdate`, never as a plain `UPDATE`:

```typescript
await runSqlMigration(ownerUrl, [
  { syncUpdate: { table: 'sync_notes', set: "status = 'archived'", where: "created_at < '2026-01-01'" } },
]);
```

It locks the rows first, then takes the change numbers like the store, then writes them with `version + 1` — the order
that cannot deadlock with a running application on MySQL / MariaDB, and the version a client's stale edit then
conflicts with. On MySQL / MariaDB each `syncUpdate` runs in a transaction of its own, because a DDL statement before
it has already committed the migration's. `set` and `where` are reviewed SQL, like every statement of a migration.

## Infrastructure models

| Model          | Collection / table                 | Holds                                                                                                                    |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SyncMutation` | `syncMutations` / `sync_mutations` | Claims and outcomes of pushed mutations, `expiresAt` (TTL on MongoDB, expiry sweep on SQL; every reader checks it)       |
| `SyncState`    | `syncStates` / `sync_states`       | Access epochs (`epoch:t:<model>:<tenant>`, `epoch:u:<model>:<tenant>:<user>`) and tombstone horizons (`horizon:<model>`) |

Both follow `database` like every other model.

## Extending

Override through `CoreModule.forRoot(env, { sync: { controller, hintsController, resolver, service } })`:

- **`CoreSyncService`** — every step is `protected`: `readChanges()`, `toSyncRecord()`, `accessState()`,
  `resolveUpdateConflict()`, `writeFailure()`, …
- **`CoreSyncController`** — e.g. to release a scope to API tokens: extend it, re-declare `pull()` / `push()` with their
  route decorators plus `@ApiTokenScopes('sync')`, and call `super`.
- **`CoreSyncHintsController`** — `GET /sync/hints`, a controller of its own that the module registers before
  `CoreSyncController`: Nest registers a class's own routes before the inherited ones, so a re-declared `pull()`
  (`@Get(':model')`) would otherwise read `hints` as a model name. Extend it the same way to release hints to API
  tokens. `CoreSyncBaseController` holds what both share (`scopeTenants()`, `limit()`).
- **`CoreSyncResolver`** — the `syncHint` subscription.
- **Access that moves past `CrudService.update()`** (a direct store write, a migration, the native API) bumps no epoch:
  call `CoreSyncService.bumpAccessEpoch(model, tenantId, userId?)` after such a write, or the clients concerned keep
  their copies until their next full resync.