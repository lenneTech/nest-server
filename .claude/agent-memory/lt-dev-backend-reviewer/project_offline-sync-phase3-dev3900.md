---
name: offline-sync-phase3-dev3900
description: DEV-3900 synchronized models review 2026-10-31 — 3 Highs (MySQL insert-vs-updateRows deadlock, existing unique index makes sync adoption unrunnable/deletes fail, aggregate hook $geoNear + includeTombstones); PG change order probed sound
metadata:
  type: project
---

Phase 3 of offline sync (version, tombstones, live-only unique, change order), reviewed 2026-10-31 against
`develop...HEAD` on `feature/dev-3900-offline-sync-datastore-erweiterungen`.

**Reported High (all reproduced by probe):**
1. MySQL / MariaDB (REPEATABLE READ default): `updateRows()` (`updateMany`/`deleteMany` on a sync model) takes next-key
   locks with `SELECT … FOR UPDATE`, then the counter row; the BEFORE INSERT trigger takes the counter first, then needs
   the insert-intention lock in that gap → ER_LOCK_DEADLOCK 1213 (the multi-row tx is the victim). Same sequence at
   READ COMMITTED does not deadlock. PostgreSQL has no gap locks — probed clean.
2. Making an EXISTING model with a unique index synchronized: SQL suggested migration references `deleted_at`, which the
   aborted run never added (PG, MySQL, MariaDB all fail); the superseded full unique index is only a notice, and the
   2nd tombstone (content cleared → NULL) then fails with duplicate key (PG and Mongo probed). Mongo: rewritten index
   has the same auto-name → IndexKeySpecsConflict swallowed by Mongoose. Also: unique in an embedded CHILD schema is
   never rewritten (eachPath/clearIndexes are top-level only) → same E11000 on a NEW model.
3. Mongo aggregate pre-hook unshifts `$match` unconditionally: `$geoNear` pipelines fail; `includeTombstones` symbol
   ignored → `CrudService.findAndCount(…, { includeTombstones })` returns no tombstones on Mongo (SQL does).

**Status: all three fixed in DEV-3900 before the merge.** MySQL / MariaDB store writes of a synchronized model take
their number last (`numbersLast()`, mutation `mysql-sync-numbers-not-last`); the SQL adoption migration adds
`deleted_at` first and drops the superseded unique index; MongoDB refuses such a collection at boot
(`assertSyncCollectionReady`, `SyncMigrationRequiredError`); a unique index inside an embedded object is refused at
registration; the aggregate hook honours `includeTombstones` and keeps `$geoNear` / search stages first.

**Verified sound (don't re-derive):** PG trigger + advisory lock + sequence order; updateRows numbering (no double/skip);
Mongo `$where` conditional save, insertMany/bulkWrite/flat-update hooks, BSON UUID lean ids (`UUID` instances);
expectedVersion atomic on both paths; non-sync paths unchanged (index names hash excludes NULLS, so existing PG indexes
are not re-planned). Probe recipe: tsx `.mts` in scratchpad, `tests/helpers/{postgres,mysql}-test-db.js` with
`NODE_ENV=e2e`, plain `mongoose.Schema` + `applySyncSchema()`. See [[db-agnostic-phase6]].
