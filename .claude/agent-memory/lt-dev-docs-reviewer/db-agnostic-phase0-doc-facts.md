---
name: db-agnostic-phase0-doc-facts
description: feat/db-agnostic phases 0-4 (DEV-3828..3832) — what the persistence docs claim vs what the code wires; silent wrong-database routes, guard leaks, fail-open recipes; changes the release guide must list
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

**Phase 2 (2026-10-28) — reported in review (verify fixed before re-flagging):**
- `guardRoutedModel()` (routed-model.guard.ts) lists static methods + `prototype.save`, but Mongoose 9.11 also has
  `Model.insertOne()` (→ `doc.$save()`), `doc.$save()` (an ALIAS bound at definition, so overriding `save` misses it)
  and `Model.where()/$where()` → exec. Probe: tsx script with `mongoose.createConnection` to local Mongo,
  `guardRoutedModel(M, { driver: 'postgres' })`, call each → insertOne/$save/where reach MongoDB. Docs (Data Sources
  row, REQUEST-LIFECYCLE Data Store row, PLAN) claim "every data method refuses / cannot split".
- `isTenantActive` README + JSDoc lead example `store('Tenant')?.findById(id))?.active !== false` fails OPEN when the
  tenant model is registered via `MongooseModule.forFeature` (what `lt server module` generates): `storeOf()` returns
  undefined → every tenant active. The parity test's own mutation (`store: () => undefined`) demonstrates it.
- Hub Migrations panel reads `lt_migrations` whenever the DEFAULT source is SQL (`defaultSqlSource()`), not where the
  project's `migrations-utils/migrate.js` keeps state; the starter's migrate.js passes the Mongo URI → panel shows all
  pending, "run" would re-apply. Hub README claims "reads the state where createMigrationStore() keeps it".
- Not reported (below bar): `createMigrationStore(pgUrl)` / `SqlStateStore` default engine `typeorm` regardless of
  `sqlEngine` (loud missing-peer); testing.md "Measured at 333 mutations, the CI job for 11.41.6" (was 128 — a
  measurement rewritten as a count; script header still says 128); Hub "17 panels" while HUB_PANELS has 18.
- Counts after phase 2: 333 / 195 unit / 138 e2e; seventeen infra suites. FRAMEWORK-API regenerates identical.

**Phase 3 (2026-10-28, DEV-3831) — Better-Auth on SQL; reported in review:**
- vitest 5 `projects`: every selected project's `globalSetup` runs BEFORE the root's (`initializeGlobalSetup` adds
  the root project last) and a throw aborts the WHOLE run ("No test files found", exit 1, zero tests). So
  `tests/iam-sql.global-setup.ts` failing on an unreachable PostgreSQL kills the `e2e` project too, and the root
  `tests/global-setup.ts` that starts the containers never runs (no `--restart` policy → after a reboot `pnpm test`
  stays red). testing.md claimed "the `e2e` project is unaffected" / "works from a clean machine".
  Probe: `PG_PORT=5999 LT_TEST_INFRA=0 NODE_ENV=e2e npx vitest run --config vitest-e2e.config.mts better-auth-signin-csrf`
  → abort, no `[test-infra]` line; same with `--project e2e -t __none__` → root setup logs, file found.
- Verified sound: passkey plugin reads only `advanced.webAuthnChallengeCookie`; default cookie `iam.better-auth-passkey`
  (prefix = basePath); `CoreBetterAuthChallengeService` is NOT barrel-exported (getCookieName change is internal);
  better-auth 1.7.13 depends on kysely + @better-auth/kysely-adapter directly ("built-in" is true).
- Counts after phase 3: 349 / 199 unit / 150 e2e.

**Phase 4 (2026-10-28, DEV-3832) — AI/MCP OAuth/file metadata on the routed store, SQL expiry sweep; reported:**
- Derived file driver gained a step (`'filesystem'` when `fileMetadataSqlSource()` finds the metadata on SQL), but
  the `file.storage` JSDoc (server-options.interface.ts ~l.1265) and file README "Choosing the driver" list (~l.110,
  incl. "step 3 is theoretical") were NOT updated — only the README's new paragraph + configurable-features row were.
  Starter Dockerfile has no VOLUME for /app/uploads → pod-local files lost on redeploy.
- "metadata always lives in MongoDB" survives in hub/README.md (~l.65, Files panel) and the class JSDocs of
  `S3FileHelper` / exported `FilesystemFileHelper` ("WHY THE METADATA STILL LIVES IN MONGO").
- Verified sound: sweep touches SQL stores only (`resolveStore` → MongooseDataStore for mongodb, `this.stores`
  SQL-only); tool grants + MCP codes check expiry on read; framework uses only the 6 ops the SQL file-collection shim
  provides; `fileMetadataCollection` is barrel-exported. Not reported: adopting SQL hides Mongo-era `s3-files`
  metadata (no "nothing is copied" note for files — release-guide item); AI README "budget sums run in the store"
  while MongoDB still aggregates natively.
- Counts after phase 4: 358 / 202 unit / 156 e2e; seventeen infra suites.

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
