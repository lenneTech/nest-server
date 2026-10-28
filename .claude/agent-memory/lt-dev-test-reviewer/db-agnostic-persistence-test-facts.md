---
name: db-agnostic-persistence-test-facts
description: feat/db-agnostic phases 0+1 (2026-10-27/28) — what the persistence specs prove, which mutations were seen red, the unpinned BYPASSRLS role-check branch, and why the three engine columns exercise one code path
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
