---
name: offline-sync-datastore-test-facts
description: DEV-3900 sync-* parity cases (reviewed 2026-10-31, HEAD b1cd584) — which mutations went red, the vacuous server-clock case, the Mongo aggregate hook ignoring includeTombstones, and what was probed green
metadata:
  type: project
---

DEV-3900 added 19 `sync-*` cases to the persistence parity matrix (10 columns). Reviewed 2026-10-31 with a git
clone + symlinked node_modules ([[scratch-copy-mutation-check]]); the parity file runs in ~2 s per filtered run.

**Reported High (check before re-reporting):**
- `schema.pre('aggregate')` in `mongo/sync-schema.plugin.ts` always prepends `$match: { deletedAt: null }` and never
  reads `INCLUDE_TOMBSTONES`, so `CrudService.findAndCount(…, { includeTombstones: true })` on MongoDB returns no
  tombstones (probe: items 1 / total 1 vs 2 / 2 on all nine SQL columns). `sync-crud-service` only checks
  findAndCount WITHOUT the option. Fix: skip the unshift when the flag is set, keep `matchLiveInJoins`.
- `sync-server-clock` mocks only `Date.now`; `new Date()` is not skewed by that. Mutant (insert via `new Date()`,
  update via `$set: { syncAt: new Date() }`) kept the case AND the whole mongodb column green. The process caches
  the server-clock reading per connection, so a `Date.now()`-reading mutant passes too once an earlier case ran.
  `vi.useFakeTimers({ now: skewed, toFake: ['Date'] })` went red on the mutant and green on the real code.

**Status: both fixed in DEV-3900 before the merge** — the hook reads the flag (mutation
`sync-aggregate-ignores-include-tombstones`, `sync-crud-service` asserts findAndCount with it), and `sync-server-clock`
fakes `Date` as a whole (mutation `sync-insert-stamps-app-clock`).

**Seen red (non-vacuous):** conditional update made non-atomic in both CrudService paths → `sync-conditional-concurrent`
red on all 10 columns. SQL tenant filter dropped only under `includeTombstones` → `sync-tenant-policy` red on the six
MySQL/MariaDB columns; PG stays green because RLS still isolates (intended second layer).

**Probed green (no defect):** Mongo `insertMany`, `bulkWrite` insert/update (version stripped, syncAt stamped), stale
loaded-document `save()` → DocumentNotFoundError. `updateRows()` over 1203 rows (3 chunks) on every SQL column:
all tombstoned, version 3, distinct and later positions.

**Why:** phase 3 (pull/push) will build on these primitives; knowing which cells are real tripwires saves re-deriving.
**How to apply:** for a clock-skew test, fake `Date` as a whole, never just `Date.now`. For a Mongoose query flag, grep
that every hook kind (query AND aggregate) reads it.
