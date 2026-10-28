---
name: db-agnostic-persistence-test-facts
description: feat/db-agnostic phases 0-4 (2026-10-27/28) — phase 2 mutations all seen red; what the persistence specs prove, which mutations were seen red, the unpinned BYPASSRLS role-check branch, and why the three engine columns exercise one code path
metadata:
  type: project
---

**Phase 0** (DEV-3828, reviewed 2026-10-27). Seen red in a scratch copy: `tenant-row-check-not-registered`,
`lock-store-takes-held-lease`, `exclude-schemas-warns-silently`, `cross-tenant-writes-accepted`, `malformed-file-id-500`.
Boot-guard gap then: `database: 'mongodb://…'` passed the guard but the connection used `config.mongoose.uri`.
Phase 1 now assigns `config.mongoose.uri = defaultSource.url` for a MongoDB default; re-check before re-reporting.

**Phase 1** (DEV-3829, reviewed 2026-10-28; 21 new mutations, `sql-*` + `crud-mongoose-api-on-sql-store`).
- The 7 persistence e2e files run in ~11 s, 292 tests, green 3/3 in a row: no flake seen.
- `sql-pool-guard-unlistened-checkout-error` confirmed through the real gate (2 tests red). Every other new
  mutation reads as the defect it claims. The red ones go red through the after-layer
  (`assertRowsInTenantScope` throws Forbidden), which is a valid tripwire.
- **Unpinned:** `assertSafeApplicationRole()` refuses a `BYPASSRLS` role, but no test uses a role that is ONLY
  BYPASSRLS. Deleting the branch leaves the schema + wiring specs green (27/27, probed). The `nest_owner` container
  role is a superuser, and its message regex `superuser.*owns` spans "has BYPASSRLS". Check whether a case was added
  before re-reporting. → PINNED 2026-10-28 (`refuses a role with BYPASSRLS`, a probe role that is ONLY that;
  mutation `sql-role-check-accepts-bypassrls`).
- `SqlDataStore` only calls `executor.run()`, which is `runInOwnTransaction(pool)` on node-postgres for EVERY engine.
  So the three Postgres columns of the parity matrix differ only in pool construction. Engine-specific code is
  `transaction()` + `native()` only, and it is covered in `persistence-sql-executor.e2e-spec.ts` per engine.
- The wiring spec's "configuration > @PersistedModel > default" cannot observe the middle level: WiringArchive is
  overridden by `database.models`. The pure parts (`resolveModelSource`, decorator) are unit-tested. Rated Medium.
  Since 2026-10-28 `WiringLedger` (decorated, registered WITHOUT `model:`) observes it.
- Since 2026-10-28 the parity matrix has CrudService cells (`crud-service-pipeline`, `crud-service-populate`) and
  `native-api-tenant-refused` (each engine's own API → 42501; MongoDB DIFFERENT-BY-DESIGN with a complement). Field
  rights at service level are NOT applied on either store — they belong to the response interceptor.
- There is no Postgres DB sweep (the Mongo lifecycle does not reach it). DBs leak only on SIGKILL; 0 leftovers seen.

**Why:** the next phase will add MySQL/MariaDB columns and more role/engine paths. Knowing which guard branches
are pinned keeps a re-review from re-deriving it.

**How to apply:** for each new security guard branch, look for a test whose fixture triggers ONLY that branch.
A superuser fixture satisfies most role checks at once and hides the others.

**Phase 2** (DEV-3830, reviewed 2026-10-28; 21 new mutations + 2 re-pointed finds). Every new mutation was applied in a
`git clone` + symlinked node_modules and its spec run with `--retry=0`: ALL went red, none vacuous. Durations: core module
parity 16 s (52 tests, both columns), lock-formats + sql-state-store a few seconds, sql-wiring ~15 s.
- The quoted 12.0.0 code in `persistence-lock-formats.e2e-spec.ts` matches `origin/feat/db-agnostic` statement for
  statement (setup claim, cron insert, one acquireLock round). Green 3/3 without retry.
- `api-token-last-used` is NOT vacuous on `updatedAt` (schema `timestamps: true`; the cell alone goes red).
- `tenant-guard-before-identification` turns EVERY authenticated route of the parity app red, not only tenant routes.
- Postgres column: services resolve stores per app via a WeakMap keyed on the Mongoose model INSTANCE
  (`getStoreForModel`), and the routed-model guard throws on any Mongoose data access, so every "X on mongo on SQL"
  mutation goes red by a throw rather than by a split write. `setPersistenceRuntime` is reset by every `forRoot()`.
- Cosmetic only: in `persistence-sql-wiring` the `crud-mongoose-api-on-sql-store` JSDoc got separated from its `it`.
- Peer sessions edited `routed-model.guard.ts` (+`$save`/`insertOne`/`where`) during the review: re-check that area.

**Phase 3** (DEV-3831, reviewed 2026-10-28, static only; 13 new mutations, `sql-users-beside-better-auth` removed).
- IAM suites run in 4 vitest projects (`e2e` + `iam-sql-<engine>`); ONE PG database per project per run, shared by all
  forks of that project (not per fork like MongoDB). JWKS verification looks keys up by kid per request, so concurrent
  key creation is harmless; no IAM suite does a global PG delete.
- `tests/helpers/iam-test-db.ts` picks PG purely from `NSC__DATABASE__OWNER_URL` (set only in IAM workers). Routing is
  proven positively by storage-paths, api.story (`user?.email`), bidirectional sync (`.password` deref), migration
  status. The csrf spec has NO positive PG anchor (its victim count would be vacuous if misrouted) — its boot uses the
  same forFeature pattern as the wiring spec, so not reported.
- Every new mutation reads as its defect statically (session/token/challenge/email-verified fall back to MongoDB, which
  holds nothing in an IAM project). Weak `toBeDefined()` on nullable finds in bidirectional sync are pre-existing.
- Found: `tests/iam-sql.global-setup.ts` needs PostgreSQL but runs BEFORE the root setup that starts the containers
  ([[vitest-projects-global-setup-order]]). The author fixed it in the working tree during the review
  (`startInfrastructureOnce()`, error handed to `iam-sql.setup.ts`, mutation `iam-sql-setup-stops-the-run`); that fix
  first forgot the six mutation counts `regression-evidence.spec.ts` pins (registry 350, unit-only 200) — check them.

**Phase 4** (DEV-3832, reviewed 2026-10-28; 6 new mutations: mcp-oauth code age x2, sql-ttl-rows-never-swept,
iam-expired-sessions-kept, file-metadata-routing-ignored, gridfs-derived-for-sql-metadata).
- `DataSourceRuntime.sweepExpired()` builds `{ field: { $lt: now - ttl } }` from the descriptor ONLY; a TTL index's
  `partialFilterExpression` is dropped. Probed end to end (wiring spec copy): a row OUTSIDE the partial filter is deleted
  on PostgreSQL, while local mongod keeps it (TTL monitor, 105 s). The schema compiler accepts partial indexes, so boot
  succeeds. Reported Critical; check whether the sweep now ANDs the partial filter before re-reporting.
- `BetterAuthSqlStore.storeChallenge()` deletes EVERY expired `lt-passkey-challenge:` verification row before inserting.
  So a test that stores an expired challenge and THEN a live one has its expired fixture removed before any sweep: the
  verification half of `deleteExpired()` survived `verificationValues: 0` (storage-paths spec green, iam-sql-kysely).
  The registered session mutation went red there (1 test). Single project run: `--project iam-sql-kysely`, ~7 s.
- Better-Auth's own passkey `generate-authenticate-options` (unauthenticated GET) writes a verification row with a
  random identifier: on SQL only the IAM sweep removes it.
- File parity PG columns are non-vacuous by construction: the harness reads via `sqlFileCollection(store)` of the
  runtime it built (shares the adapter, not the routing), and the HTTP column plants into SQL and downloads.
- iam-sql projects share ONE PG DB per project; ai.e2e-spec's `deleteMany({})` on AI tables is safe because no other
  IAM-project file touches those tables (ai-mcp-oauth-tenant gets its own PG DB).
- Hook blocks any command text containing a database-drop call (also `col.drop()`); for a Mongo probe use a DB named
  `nest-server-e2e-run-1700000000000-p1` + `deleteMany` — the next run's startup sweep collects it (age > 7 d).
