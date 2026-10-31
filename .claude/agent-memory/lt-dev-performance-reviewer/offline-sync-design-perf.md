---
name: offline-sync-design-perf
description: Offline-sync (DEV-3819) design review — phase-1 traps (partial index, epoch fan-out, C2 livelock) and phase-2 cursor-decision traps (C1d counter row, bypass deadlock, tenant index prefix, MongoDB W amplification) to re-check in phases 3-5
metadata:
  type: project
---

## Phase 1 (DEV-3898, 2026-10-29), all fixed in the plan before merge

1. **MongoDB partial unique index vs read filter**: filter and `partialFilterExpression` must be the same form.
   Phase 2 switched both to the equality `{ deletedAt: null }` (IXSCAN on 5.0/7.0/8.2, covers a missing field).
2. **Access epoch bumped by per-user events** sends a whole tenant into full resync. Plan keeps per-user events in `fp`.
3. **C2 page-wise overlap window never advances** past more than `limit` equal keys. Phase 2's lab (`cursor-lab.mjs`
   Client.run) uses keyset + once-per-run low-water mark — verified terminating.

## Phase 2 (DEV-3899, 2026-10-31): decision C1d on SQL, C2 on MongoDB — reported as findings

1. **Bypass multi-row writes are counter-first.** The `BEFORE ROW` trigger takes the counter at the FIRST row of a
   non-sentinel multi-row statement (tier 2/3, migrations, Hub-run migrations) and then locks the rest — the C1 order
   the plan rejected; deadlocks with row-first store writes (PG detects after `deadlock_timeout` 1 s, counter held
   meanwhile; MySQL rolls back the smaller txn, store has no deadlock retry). Also a single INSERT takes the counter
   before its unique-index wait.
2. **PG counter row = one tuple version per bump.** A deferred multi-row final statement firing the row trigger N
   times makes N unprunable versions in one txn, each bump walks all earlier ones (O(N²) under the counter lock). A
   long snapshot (pg_dump, report, idle-in-tx, slot) does the same across txns. Fix ideas: bump once by N; advisory
   xact lock + sequence (no tuple versions). MySQL updates the row in place — not affected.
3. **Pull indexes lack the tenant prefix**: plan states `{ syncAt: 1, _id: 1 }` (Mongo) and `sync_seq` + index (SQL);
   the tenant policy adds `tenantId` to every pull, and `mongooseTenantPlugin` only adds `{ tenantId: 1 }`.
4. **MongoDB W ≥ 60 s** (from `transactionLifetimeLimitSeconds`) vs 5 s measured: every run re-reads R·W records;
   a hint-driven client (250 ms collapse) receives each change ~W/Δ times through the full output pipeline.
   Protocol called it "a short window". Standalone has no transactions to cover.

Dropped (below High): MySQL/MariaDB C1d throughput measured on autocommit `executor.run`, but `MysqlDataStore` wraps
every write in a transaction with a readback, so the counter would be held across ≥ 1 client round trip; writes/s
include writer startup + late tail (uniform across variants, ratios hold); 17,768-page run near the 20,000 cap is
head-chasing (no run bound in the design).

Already fixed in the working tree during the review: per-(model, tenant) counter needs a per-tenant position or
single-tenant pulls (header-less pull spans `tenantId $in memberships`).

**Why:** these come from the design text, not code; a green parity matrix shows none of them.
**How to apply:** phase 3 (DEV-3900) review — check how the final statement takes the counter (once per statement?),
whether bypass/migration writes follow the sentinel protocol, the pull indexes on a tenant-scoped model (`explain()`),
and how W is sized per MongoDB topology.

## Phase 3 (DEV-3900, 2026-10-31, code review): one High
- HIGH (MySQL/MariaDB only): the BEFORE INSERT trigger bumps the counter row BEFORE InnoDB's insert-intention gap
  check, so a store INSERT holds the counter and then waits on a REPEATABLE-READ gap lock of `updateRows()`'s
  `SELECT … FOR UPDATE` (or a non-PK `lockFirst`/`tombstone` pick), which then asks for the counter → ER_LOCK_DEADLOCK
  1213, unmapped → 500. Measured (probe db, real tables, verbatim trigger): 4 insert loops + 1 multi-row loop on one
  tenant, 8 s: MySQL 810 insert deadlocks / ~6.2k, MariaDB 798 / ~16.5k; same with the multi-row tx under READ
  COMMITTED: 0 on both. PG unaffected (no gap locks). Scripts: scratchpad `mysql-sync-deadlock*.mjs` pattern.
- Status: fixed in DEV-3900 before the merge — every MySQL / MariaDB store write of a synchronized model takes its
  number last (`numbersLast()`), matrix case `sync-concurrent-writes`, mutation `mysql-sync-numbers-not-last`.
- Settled: non-sync paths unchanged (same statements/query counts; getters are symbol/WeakMap reads); PG uses advisory
  xact lock + sequence (no counter tuple versions — P2 #2 resolved); tenant-led pull indexes present on Mongo + SQL
  (P2 #3 resolved); MySQL live-key unique columns get the base-column companion index; trigger skips rows whose
  sync_seq the statement sets, so updateRows takes the lock once; MySQL counter held across readback+COMMIT RTTs is
  the plan-named design cost (§5), it widens the deadlock window.

Scratch MongoDB tests: a PreToolUse hook blocks `dropDatabase`. Name scratch DBs
`nest-server-e2e-run-<ts>-p<pid>-<suffix>`, so the next e2e run's startup sweep removes them once the PID is dead.

## Phase 4 (DEV-3901, 2026-10-31, static review — no DB allowed): one High
- HIGH: the pull (`readChanges`) orders by the change position, but the only change-order index is tenant-led
  (`(tenant_id, sync_seq)` / `{ tenantId, syncAt, _id }`). A header-less pull (the protocol default: spans the
  memberships) filters `tenantId: { $in }` → PG `tenant_id = ANY($n)`. A SAOP makes no constant EquivalenceClass, so
  the index pathkeys stay `(tenant_id, sync_seq)` and `ORDER BY sync_seq` needs a Sort over ALL remaining scope rows
  per page — even for ONE membership on PG (MySQL `IN (?)` single value is fine, ≥2 not). Admin bypass (no tenant
  predicate) is the same on every DB incl. MongoDB. Full sync ≈ R²/(2L) rows. MongoDB members are fine (single $in =
  point interval; multi = explode-for-sort).
- Status: the member case is fixed in the same review — `readPositions()` reads a membership list once per tenant with
  `tenantId` as an equality and merges by position (case `pull-across-tenants`). The admin-bypass case is NOT changed:
  it would need a non-tenant-led change index on every tenant-scoped sync table, judged below the bar (platform admins
  rarely run sync clients). Re-raise only with a concrete admin sync client.
- Settled: `CrudService.update()` sync hooks short-circuit on a module variable (no clone/lookup without sync); pull =
  limit+1 read + ONE `id IN` system-field query per page; push ≤ 100 items × constant queries; no timers/races.
- Dropped: maxBytes read amplification (page reads limit+1 full records, may return few) — protocol defines the page.

**How to apply (general):** whenever a pull/list paginates by a keyset under the tenant policy, check whether the
scope is an equality (`tenantId`) or a list (`tenantIds` → `$in`/`ANY`): on PostgreSQL only the equality lets a
tenant-led index serve the ORDER BY.

## Phase 5 (DEV-3902, 2026-10-31, static review — no DB allowed): one High
- HIGH (MySQL/MariaDB): the hourly tombstone purge is ONE `DELETE FROM t WHERE deleted_at < ?` (SqlDataStore.deleteMany,
  inherited by MysqlDataStore) and NO synchronized table has an index led by `deleted_at` (only live-unique partials,
  `lt_lk_*`, `(tenant_id, sync_seq)`). Session isolation is the server default REPEATABLE READ (MYSQL_SESSION_SQL sets
  none) → InnoDB next-key-locks EVERY scanned row + gap for the statement: all store writes of that model (all tenants)
  wait; > innodb_lock_wait_timeout 50 s → 1205. First run at bootstrap meets the whole backlog. Fix: non-locking id
  batch SELECT + `DELETE … WHERE id IN (…) AND deleted_at < ?` per short statement, plus a `deleted_at` index.
  PG (ROW EXCLUSIVE, matched rows only) and Mongo (COLLSCAN, yields) only pay a full scan per hour — below the bar.
- Settled: non-sync CrudService paths add one module-variable read (`getSyncAccessListener()`) + capabilities getter;
  hint `pending` Map bounded by (model, tenant) per debounce window; GraphQL iterator queue capped at 100 and
  `withRequestContextAsyncIterator` forwards `return()`; SSE end() clears keepalive + unsubscribes + unregisters.
- Below the bar, re-check if scale grows: `CoreSyncHintService.deliver()` calls EVERY subscriber for EVERY hint
  (fleet-wide via Redis) — O(S×H), est. 30-50 ns per filtered-out call → ~6 % at 2k subs × 800 hints/s, saturates
  near 5k × 4k/s. Fix would be an index Map<model, Map<tenant|'*', Set>>.
- Below the bar: SSE `reauthenticate: () => undefined` makes every stream terminate (and LOG "Session no longer
  valid") at the first accepted hint after subscriptionRevalidationMs (~30 s); SSE attaches `request.on('close')`
  only after awaits (limit, scopeTenants, hintFilter) — an abort in that window leaks the subscriber until a hint/
  invalidation; `applySyncUpdate` holds the number lock (PG advisory / MySQL counter row) to migration commit (needed
  for commit order).
- Resolved in DEV-3902 before merge: the purge reads ids in primary-key order (keyset, 1000 per batch, no lock) and
  deletes `id IN (…) AND deleted_at < ?` per batch (mutation `sync-purge-single-statement`). No `deleted_at` index was
  added; the early-close leak was fixed too (mutation `sync-hint-stream-late-close`).
