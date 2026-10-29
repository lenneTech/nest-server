---
name: db-agnostic-phase1
description: feat/db-agnostic phase 1 (DEV-3829) review 2026-10-28 — SQL store/compilers verified injection-safe and tenant-sound; two update-path Highs reported (unknown keys, structuredClone kills ObjectIds)
metadata:
  type: project
---

Phase 1 (PostgreSQL `SqlDataStore`, executor port, compilers, migrator, data-source runtime, neutral CrudService
path), reviewed 2026-10-28 against `origin/feat/db-agnostic...HEAD`.

**Verified sound (don't re-derive):** Mongo path unchanged (`usesNeutralStore` false for any Mongoose-derived store,
`toPopulateOptions` equivalent to the old inline branches, MongooseDataStore select guard only reached by neutral
callers). Where/update/schema compilers: identifiers only from the descriptor + `quoteIdentifier`, JSON paths and
values bound as params, jsonType/alias/operators from constants. Tenant: app filter ANDed via `$and`, RLS FORCED,
guard function raises 42501 on empty/missing scope (pooled-connection leftover reads ''), row check after reads.

**Reported High:** (1) `CrudService.update` neutral path passes the merged record whole to `compilePostgresUpdate`,
which refuses undeclared fields — `updatedBy` on a model extending `CorePersistenceModel` directly, or any
non-persisted UpdateInput key → 500 for every authenticated update (insert drops them like Mongoose strict).
(2) `SqlDataStore.updateById` deep-copies with `structuredClone`, which turns a BSON ObjectId into `{i0..i3}` →
`QueryCastError` → 500; insert/find/pushToArray accept the same value.

**Status:** both Highs FIXED 2026-10-28 in the review's fix round — `SqlDataStore.dropUndeclared()` (Mongoose strict
semantics for update paths) and an ObjectId-safe `clone()`; mutations `sql-update-keeps-undeclared`,
`sql-update-clone-loses-object-id`.

**How to probe without Postgres:** tsx script in the scratchpad importing `src/...js` paths directly, fake executor
`{ engine, run: async (s) => ({ rowCount, rows }) }`, and `new ConfigService({ env: 'local' })` first (prepareInput
reads `configFastButReadOnly.sha256`).

**Not reported (design):** a service using `@InjectModel` (`mainDbModel` only) for a model routed to SQL keeps
reading/writing MongoDB silently — phase-1 coexistence keeps `mainDbModel`; revisit in phase 2/5.
See [[db-agnostic-phase0]].
