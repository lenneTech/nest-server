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

Nothing without the `sync` configuration: no route, no infrastructure model, no listener on the write paths. Hints
(SSE, GraphQL subscription) and the tombstone purge come with the next phase.

## Configuration (`sync`, presence implies enabled)

```typescript
sync: {
  cursorSecret: process.env.SYNC_CURSOR_SECRET,  // else SECRETS_ENCRYPTION_KEY; REQUIRED in production / staging
  path: 'sync',
  pull: { defaultLimit: 200, maxLimit: 1000, maxBytes: 1_048_576, windowSeconds: undefined /* MongoDB, derived */ },
  push: { maxItems: 100 },
  retention: { mutationsDays: 30 },
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

## Infrastructure models

| Model          | Collection / table                 | Holds                                                                                                                    |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SyncMutation` | `syncMutations` / `sync_mutations` | Claims and outcomes of pushed mutations, `expiresAt` (TTL on MongoDB, expiry sweep on SQL; every reader checks it)       |
| `SyncState`    | `syncStates` / `sync_states`       | Access epochs (`epoch:t:<model>:<tenant>`, `epoch:u:<model>:<tenant>:<user>`) and tombstone horizons (`horizon:<model>`) |

Both follow `database` like every other model.

## Extending

Override through `CoreModule.forRoot(env, { sync: { controller, service } })`:

- **`CoreSyncService`** — every step is `protected`: `readChanges()`, `toSyncRecord()`, `accessState()`,
  `resolveUpdateConflict()`, `writeFailure()`, …
- **`CoreSyncController`** — e.g. to release a scope to API tokens: extend it, re-declare `pull()` / `push()` with their
  route decorators plus `@ApiTokenScopes('sync')`, and call `super`.
- **Access that moves past `CrudService.update()`** (a direct store write, a migration, the native API) bumps no epoch:
  call `CoreSyncService.bumpAccessEpoch(model, tenantId, userId?)` after such a write, or the clients concerned keep
  their copies until their next full resync.