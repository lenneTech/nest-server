---
name: db-agnostic-phase0-doc-facts
description: feat/db-agnostic phase 0 (DEV-3828) — what the persistence docs claim vs what the code wires; the release guide must list phase-0 changes the plan calls "zero behaviour change"
metadata:
  type: project
---

State verified 2026-10-27 on `feat/db-agnostic` (unreleased; migration guide due in phase 5, DEV-3833).

**Aspirational surfaces — the code does not do this yet:**
- `@PersistedModel({ dataSource })` only writes reflect-metadata. `getPersistedModelOptions()` and
  `resolveModelSource()` have NO caller, so an unknown source name is never refused and the declared
  source is never honoured. Docs stating "precedence `database.models` > `@PersistedModel` > default"
  (configurable-features Data Sources row, `IDatabaseConfig` JSDoc) describe the design, not phase 0.
  Harmless while `assertDataSourcesSupported()` refuses every non-default source; re-check the moment
  that guard widens (phase 1).
- `CrudService` find/get/create/update/delete still use `mainDbModel`; only `distinct`, `pushToArray`,
  `pullFromArray` go through `this.dataStore` (PLAN.md "Decided while implementing phase 0").

**Behaviour changes for MongoDB projects despite PLAN.md §6 "Phases 0–4 change nothing":**
1. Tenant row check (post `find`/`findOne`/`findOneAnd*` hooks) — new 403 + error log; on
   `findOneAndUpdate` with `new: true` it fires AFTER the write committed.
2. `IdType` / `StringOrObjectId` use structural `ObjectIdLike` instead of `Types.ObjectId` (compile-loud).
3. `ModuleService` gained `protected get dataStore()` — a consumer member of that name collides
   (compile-loud; no local consumer had one on 2026-10-27).
4. Every boot now parses `mongoose.uri` through `driverFromUrl()` — a non-`mongodb(+srv)://` URI fails
   with `DataSourceConfigError` before Mongoose sees it.

**Why:** a release-guide author following PLAN.md's "only phase 5 carries a breaking change" would omit
all four. **How to apply:** when the db-agnostic release guide is reviewed, check it lists these; see
[[migration-guide-behavior-change-count-trap]]. Mutation counts on this branch: 281 / 186 unit / 95 e2e
([[number-drift-in-tooling-prose]]).
