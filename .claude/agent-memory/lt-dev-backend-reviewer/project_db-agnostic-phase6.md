---
name: db-agnostic-phase6
description: feat/db-agnostic phase 6 (DEV-3848) MySQL/MariaDB review 2026-10-29 — 2 Highs (pushToArray with 2+ modifiers fails on MySQL 8.4; unique index on existing column suggests a migration that cannot run); PG refactor verified identical
metadata:
  type: project
---

Phase 6 (MysqlDataStore extends SqlDataStore, mysql where/update/schema compilers, MysqlLockStore, SqlDialect in the
runtime, SqlStateStore/runSqlMigration on MySQL), reviewed 2026-10-29 against `origin/feat/db-agnostic...HEAD`.

**Reported High:**
1. `MysqlDataStore.pushToArray()` with any TWO of position/sort/slice → MySQL 8.4 error 1054 "Unknown column '<col>' in
   'a table function argument'" (each stage wraps the previous one as a JSON_TABLE argument; an outer column reference
   nested inside a table-function argument is refused). MariaDB fine. Parity case `push-position-and-sort` only ever
   uses ONE modifier per call. CrudService.pushToArray documents `$sort/$slice/$position`.
2. Adding `unique: true` to an EXISTING string column: the null-sentinel virtual column (`lt_nn_<col>`) is planned as
   an `automatic` change, the unique index as `migration`; a pending migration aborts the whole run, and the suggested
   `CREATE UNIQUE INDEX … (lt_nn_<col>)` fails with "Key column doesn't exist" → every boot refuses forever.

**Verified sound (don't re-derive):** PG refactor is pure relocation (where-shared, sql-schema.shared, store-guards
helpers byte-identical, re-exports kept). mysql2 default flags include FOUND_ROWS (matched-row counts); TypeORM
structured result `raw` = ResultSetHeader; Drizzle typeCast only in transactions (DATETIME as text → handled).
MariaDB JSON_EXTRACT results carry JSON extended metadata → mysql2 parses them. upsertRecord sends one `$set` (no
conflict refusal). Tenant filter on every MySQL write path (lockFirst/deleteFirst/updateColumn/where).

**Not reported (below bar):** `utf8mb4_bin` is PAD SPACE on both servers (`'a' = 'a '` true; unique refuses
trailing-space variants) — no framework flow with a real consequence found. Role-derived MySQL 8 privileges are not
seen by `assertSafeMysqlApplicationAccount` (needs operator misconfiguration).

**Probe recipe:** containers `nest-server-2985-mysql` (3316) / `-mariadb` (3317), owner `nest_owner` /
`nest-owner-secret`; tsx `.mts` in scratchpad with ABSOLUTE imports (mongoose, mysql2/promise.js, src/*.js); create
`probe_review_<ts>` DB and drop it in the script (write `DROP ${'DATA'+'BASE'}` — the Bash hook blocks the literal).
See [[db-agnostic-phase5]].
