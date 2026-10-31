# Sync Integration Checklist

Offer a model to offline clients (`docs/offline-sync-protocol.md`). Background: [`README.md`](./README.md).

## Reference Implementation

- Local: `node_modules/@lenne.tech/nest-server/src/server/modules/sync-note/`
- GitHub: https://github.com/lenneTech/nest-server/tree/develop/src/server/modules/sync-note

The reference is not part of the reference server (`ServerModule` does not import it); the sync contract suite runs on
exactly these files.

## Required Files (Create in Order)

### 1. Enable the module

**Edit:** `src/config.env.ts`

```typescript
sync: { cursorSecret: process.env.SYNC_CURSOR_SECRET },
```

WHY: the cursors are signed with it. Without `sync.cursorSecret` (or `SECRETS_ENCRYPTION_KEY`) the boot fails in
`production` / `staging`.

### 2. The model

**Create:** `src/server/modules/<module>/<module>.model.ts`
**Copy from:** `sync-note.model.ts`

- `@PersistedModel({ sync: { roles: { pull, create, update, delete }, strategy } })` — declare all four roles.
  WHY: the roles on your controllers do not reach `/sync`; an operation without roles here is open to admins only.
- Do **not** declare `version`, `deletedAt`, `syncAt`, `syncSeq` — the store adds them (a declared one is refused).
- Declare `createdBy` when an operation uses `S_CREATOR` or `securityCheck()` decides by the creator.
- `securityCheck()` decides who sees a record — a pull and every push lookup run through it.

### 3. The inputs

**Create:** `inputs/<module>-create.input.ts`, `inputs/<module>.input.ts`
**Copy from:** `inputs/sync-note-create.input.ts`, `inputs/sync-note.input.ts`

WHY: a push's `data` is validated and whitelisted against them exactly like a request body — only what they declare
can be set.

### 4. The service

**Create / edit:** `<module>.service.ts`
**Copy from:** `sync-note.service.ts`

```typescript
@SyncService({ createInput: NoteCreateInput, model: Note, updateInput: NoteInput })
```

For `strategy: 'custom'` implement `resolveSyncConflict(context)` (`SyncConflictResolver`); the boot fails without it.

### 5. The module

**Edit:** `<module>.module.ts` — register the model with `CorePersistenceModule.forFeature([{ model, name, schema }])`
**Copy from:** `sync-note.module.ts`

WHY: only a model registered this way can be synchronized (its store maintains the system fields).

### 6. An EXISTING model with data

Making an existing model synchronized is a migration on every database: the boot refuses with the statements to apply
(SQL: the `deleted_at` column, the live-only unique index, `DROP` of the full one; MongoDB:
`SyncMigrationRequiredError`). See `.claude/rules/persistence.md` → "Synchronized models".

## Verification Checklist

- [ ] The boot logs `Offline sync for <Model>` and no "declares no sync roles" warning
- [ ] `GET /sync/<Model>` answers `{ items, cursor, hasMore }` for a signed-in user with the pull roles, 403 without
- [ ] A push of `{ mutationId, op: 'upsert', id, data }` answers `applied` with `version: 1`; the same push again too
- [ ] A user of another tenant pulls none of the records and gets `not_found` / `ID_UNAVAILABLE` for their ids
- [ ] `GET /sync/hints` (EventSource) sends `event: change` after a write in the user's scope, and nothing for another
      tenant's; the client pulls on every hint and once after every reconnect
- [ ] Writes past the CrudService (data store, native API, migration) call `CoreSyncService.notifyChange()`, and
      multi-row data migrations on a synchronized SQL table use `runSqlMigration()` with `syncUpdate`
- [ ] The client deletes every local record, cursor and unsent change on logout and on an account switch (the device
      holds personal data — see [SECURITY.md](./SECURITY.md))

## Common Mistakes

| Mistake                                               | Symptom                                                                  | Fix                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| No `sync.roles`                                       | Every push of a user is `rejected` / `FORBIDDEN`, pull 403; boot warning | Declare all four operations                                 |
| `@SyncService()` missing                              | `404` for the model                                                      | Decorate the CrudService                                    |
| Model registered with `MongooseModule.forFeature()`   | Boot error "not registered with CorePersistenceModule.forFeature()"      | Use `CorePersistenceModule.forFeature()`                    |
| A system field declared on the model                  | Boot error "reserved on a synchronized model"                            | Remove it — the store maintains it                          |
| Writes to a tenant-scoped model without `X-Tenant-Id` | Rejected by the tenant policy                                            | Send the header on writes; pulls may span all memberships   |
| Records moved by a direct store / native write        | Previous owners keep their copies                                        | Call `CoreSyncService.bumpAccessEpoch()` after such a write |
| A driver's default `new ObjectId()` on the client     | Ids predictable from one observed id                                     | Random tail per protocol §3, or uuidv7                      |