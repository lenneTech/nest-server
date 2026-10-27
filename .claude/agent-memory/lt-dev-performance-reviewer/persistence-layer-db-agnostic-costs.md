---
name: persistence-layer-db-agnostic-costs
description: Measured hot-path costs of the feat/db-agnostic persistence layer (tenant post-read row check, ObjectId tag check, dataStore getter) — all verified non-regressions on 2026-10-27
metadata:
  type: project
---

Reviewed `feat/db-agnostic` (DEV-3828, steps 4-8) on 2026-10-27; zero perf findings. Measured numbers to
reuse instead of re-deriving:

- **Tenant after-layer** (`assertRowsInTenantScope`, post `find`/`findOne`/`findOneAnd*` in
  `mongooseTenantPlugin`): 16 ns/row lean, 29 ns/row hydrated with 3 allowed tenants; 69-89 ns/row with
  50 memberships (O(rows x memberships) via `includes`). Reference: `Model.hydrate` is ~2,000 ns/row, so the
  check is 1-4 % of hydration. Registered only on schemas with a `tenantId` path; with multi-tenancy off it
  exits on one frozen-config read. Admin-bypass without header skips the loop entirely.
- **`isObjectIdLike` (bson `_bsontype` tag)** in `getStringId`: 1.8-4.3 ns vs `instanceof Types.ObjectId`
  4.5-5.9 ns — faster, not slower.
- **`ModuleService.dataStore` getter**: builds one `MongooseDataStore` per service, cached until
  `mainDbModel` is replaced. Only `CrudService.distinct/pushToArray/pullFromArray` use it; same queries as before.
- `registerModelSchema`/`describeSchema`/`resolveDataSources`: boot-only (`CorePersistenceModule.forFeature`,
  `CoreModule.forRoot`). `MongoLockStore` was not wired into cron yet at review time.

**Why:** the branch touches every Mongoose read in every consumer, so the next reviewer will be asked the
same "per-row cost" question.
**How to apply:** re-measure only if the row check gains per-row allocation (e.g. a Set built per query or
a populated `tenantId` resolution), or if `toRecord`/`MongooseDataStore.find` moves onto the CrudService
`find()` hot path — today it is not on it. Related: [[config-service-get-cost]].
