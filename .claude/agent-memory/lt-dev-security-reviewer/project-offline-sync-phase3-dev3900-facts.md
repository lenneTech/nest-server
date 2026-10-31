---
name: project-offline-sync-phase3-dev3900-facts
description: DEV-3900 synchronized models (version/tombstones/live-only unique/change order) review 2026-10-31 — zero findings; what was traced sound, the below-bar Mongo $rename gap, what to re-check when phase 4 (/sync module) lands
metadata:
  type: project
---

Reviewed `feature/dev-3900-offline-sync-datastore-erweiterungen` (b1cd584) on 2026-10-31. **Zero reported findings.**

**Traced sound (do not re-derive):**
- Tenant: SQL `tombstone()` = tenant-filtered `SELECT … FOR UPDATE` → `toRecords()` row check → `UPDATE … WHERE id = $`
  in one `transact()` with the request scope; `updateRows()` locks tenant-filtered ids then writes `WHERE id IN (…)`
  (no row check, same as the old updateMany); `takeChangeNumbers()` touches no tenant data. `includeTombstones` only
  drops the live condition, never the tenant filter (SQL `where()`, Mongo `matchLive`). Mongo tombstone = marked
  `findOneAndUpdate` / `updateMany` → tenant plugin hooks both.
- System fields: SQL `syncInsertRecord` + `stripSyncFields` (heads of plain keys and every operator object) run before
  `dropUndeclared`; `insertValues`/compiler resolve keys by descriptor NAME (a snake-case `sync_seq` key is no bypass).
  Mongo: pre-save sets/throws, `syncUpdate` on findOneAndUpdate/updateOne/updateMany, insertMany + bulkWrite hooks
  (Mongoose 9.11 passes `[arr]` / `[ops, options]` first — verified in model.js). CrudService write-back of the stored
  record is stripped on both paths. ServiceOptions `includeTombstones` / `expectedVersion` are never filled from the
  request (RESTServiceOptions → currentUser + language only).
- Revival: no caller can clear `deletedAt`; client-id insert onto a tombstone = duplicate key; Mongo save of a
  tombstone fails on `$where` (honoured, model.js:328).
- SQL: all new statements bind values; identifiers via quoteIdentifier / shortName; PG trigger fn is SECURITY INVOKER
  with `SET search_path = pg_catalog`; app role gets only `USAGE` on the sequence (no setval). MySQL triggers run as
  DEFINER (owner); app account needs nothing new (DB-level DML already covers `lt_sync_counters`).

**Below the bar (no user path) — answer if asked:** Mongo `syncUpdate`/`isSystemPath` checks operator KEYS only, so
`$rename: { someField: 'deletedAt' | 'version' }` through a direct model / MongooseDataStore call writes a system field
(SQL refuses `$rename`). Also Mongo `insertMany(singleObject)` skips the hook (not an array) — same shape as the tenant
plugin's. `aggregate` hook ignores `includeTombstones` (hides more, functional only). Per-table counter: `syncSeq` gaps
reveal other tenants' write volume (design choice after DEV-3899).

**Status after the review:** the `$rename` gap and the aggregate `includeTombstones` were fixed in DEV-3900 before the
merge (the hook drops a `$rename` onto a system field; tested in `tests/mongoose-plugins.e2e-spec.ts`).

**How to apply in the phase-4 (/sync module, DEV-3901) review:** check `sync.roles` reach every CrudService call, no
create-repeat comparison, tombstone pull scoped by tenantId + `sync.scope` fields, and that the module never passes
`includeTombstones` into update/delete paths. Related: [[project-offline-sync-spec-dev3898-facts]],
[[project-offline-sync-phase2-dev3899-facts]], [[project-db-agnostic-phase6-mysql-facts]]
