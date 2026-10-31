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

Scratch MongoDB tests: a PreToolUse hook blocks `dropDatabase`. Name scratch DBs
`nest-server-e2e-run-<ts>-p<pid>-<suffix>`, so the next e2e run's startup sweep removes them once the PID is dead.
