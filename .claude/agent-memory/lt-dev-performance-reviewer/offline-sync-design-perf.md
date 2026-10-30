---
name: offline-sync-design-perf
description: Offline-sync (DEV-3819) design review — measured MongoDB partial-index trap, epoch fan-out and C2 progress gap to re-check in phases 2-5
metadata:
  type: project
---

Phase-1 review (DEV-3898, 2026-10-29) of `.claude/plans/offline-sync/PLAN.md` + `docs/offline-sync-protocol.md` found three
perf defects in the design text. All three were fixed in the plan before the merge (E2 reads `$type: 'null'`; §3.8 keeps
per-user events in the cursor `fp` and bumps the epoch only for `invalidateTenant()`, tenant moves and per-user
`syncScope`; C2 continues by keyset with a separate low-water mark, and phase 2 got a progress scenario). Re-check them
when phases 2-5 land, because the code may copy older wording.

1. **MongoDB partial unique index is unused by a `{deletedAt: null}` filter** — measured on MongoDB 8.2.3, 20k docs:
   partial `{deletedAt: {$type: 'null'}}` + query `{email, deletedAt: null}` (or `$eq: null`) = COLLSCAN, 20000 docs
   examined; `{email, deletedAt: {$type: 'null'}}` = IXSCAN, 1 doc. The read filter must be byte-identical to the
   partial filter. PostgreSQL is fine (`$type null` and `null` both compile to `IS NULL`). MySQL is fine as long as the
   live-key columns go through the sentinel path, which adds a plain lookup index (`mysql-schema.compiler.ts`
   `desiredIndexes()`).
2. **Access epoch per (model, tenant), bumped by per-user events** (membership add/remove/role, setRoles,
   role/verification update) makes every member of the tenant run a full resync, or every client of the app when there
   is no multi-tenancy. The cursor `fp` already covers the caller's own changes.
3. **C2 overlap-window pull (`syncAt >= at − W`) never advances** when more than `limit` records fall inside W. A
   one-statement backfill (`now()` / `$$NOW` / `ADD COLUMN … DEFAULT now()`) gives every row the same timestamp.

**Why:** these defects come from the plan's design, not from the code. A green parity matrix will not show any of them.
**How to apply:** in phase-3 review, check what E2 actually compiles to on MongoDB with `explain()`. In phase 4, check
which events bump the epoch. In phase 2, check that the cursor makes progress when a burst is larger than a page.

Scratch MongoDB tests: a PreToolUse hook blocks `dropDatabase`. Name scratch DBs
`nest-server-e2e-run-<ts>-p<pid>-<suffix>`, so the next e2e run's startup sweep removes them once the PID is dead.
