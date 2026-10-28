---
name: db-agnostic-phase0-doc-facts
description: feat/db-agnostic phases 0+1 (DEV-3828/3829) — what the persistence docs claim vs what the code wires; silent wrong-database routes; changes the release guide must list
metadata:
  type: project
---

State verified 2026-10-27 (phase 0) and 2026-10-28 (phase 1) on `feat/db-agnostic` (unreleased; migration guide
due in phase 5, DEV-3833).

**Phase 1 (2026-10-28) — silent wrong-database routes found in review:**
- `@PersistedModel({ dataSource })` is read ONLY when the class is also passed as `model:` in the
  `CorePersistenceModule.forFeature()` definition (`core-persistence.module.ts` ~l.41). Decorator alone →
  `declaredSource` undefined → default source (usually MongoDB), no log line. Decorator JSDoc, the module's own
  example (no `model:`), the `IDatabaseConfig` JSDoc and the configurable-features Data Sources row did not say so.
  Probe: forFeature([{ name, schema }]) on a decorated class → `routed to: default -> mongodb`.
- `NSC__DATABASE__OWNER_URL` (named by migrate README + hard-coded in the `--sql` template) over a STRING-form
  `database: 'postgres://…'` in config.env.ts wipes the URL (see [[nsc-env-merge-replaces-shorthand]]) → Postgres
  default vanishes, models land in MongoDB, ownerUrl ignored. `resolveDataSources()`'s mongoose-fallback branch
  drops `config.ownerUrl` without a word.
- Both FIXED 2026-10-28: `@PersistedModel` is also found by the class name (`getPersistedModelOptionsByName()`,
  refuses two same-named classes naming different sources), and `ownerUrl` without `url` stops the boot with a
  `DataSourceConfigError` that names the env-merge cause. Docs (Data Sources row, migrate README, IDatabaseConfig
  JSDoc) say so.
- `runSqlMigration()` defaults to engine `typeorm` regardless of `sqlEngine` (boot uses the configured engine) —
  loud "install typeorm" on kysely/drizzle-only projects; Medium, not reported.
- SQL TTL indexes become plain indexes with no boot notice (PLAN only) — Medium.
- Counts after the phase-1 review fixes: 312 / 194 unit / 118 e2e; fifteen infra suites. FRAMEWORK-API regenerates identical.

**Phase 0 — still relevant for the release guide (behaviour changes for MongoDB projects despite PLAN.md §6
"Phases 0–4 change nothing"):**
1. Tenant row check (post `find`/`findOne`/`findOneAnd*` hooks) — new 403 + error log; on
   `findOneAndUpdate` with `new: true` it fires AFTER the write committed.
2. `IdType` / `StringOrObjectId` use structural `ObjectIdLike` instead of `Types.ObjectId` (compile-loud).
3. `ModuleService` gained `protected get dataStore()` (phase 1 adds `usesNeutralStore`, CrudService
   `assertMongooseStore`) — a consumer member of that name collides (compile-loud).
4. Every boot now parses `mongoose.uri` through `driverFromUrl()` — a non-`mongodb(+srv)://` URI fails
   with `DataSourceConfigError` before Mongoose sees it.

**Why:** a release-guide author following PLAN.md's "only phase 5 carries a breaking change" would omit
these. **How to apply:** when the db-agnostic release guide is reviewed, check it lists them; see
[[migration-guide-behavior-change-count-trap]], [[number-drift-in-tooling-prose]].
