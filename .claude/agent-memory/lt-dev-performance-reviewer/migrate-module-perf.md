---
name: migrate-module-perf
description: Perf profile of src/core/modules/migrate — boot/CLI-only (no HTTP path), Set-based O(n+m) identity since feature/migrate-safe-ts-js-transition; per-migration state save in up() loop is intentional crash-safety, do NOT flag as N+1.
metadata:
  type: project
---

Migrate module (`src/core/modules/migrate/`) performance profile — reviewed 2026-07-19 on `feature/migrate-safe-ts-js-transition`.

**Why:** Avoid re-deriving the execution context and re-flagging deliberate patterns in future reviews of this module.

**How to apply:** When migrate-module files appear in a diff, apply these dispositions; only re-check items in the last bullet.

- **Execution context:** `MigrationRunner` runs ONLY at boot (docker-entrypoint before server start) or via CLI (`bin/migrate.js` → `cli/migrate-cli.ts`). No HTTP request path in-repo. k6/latency analysis is never applicable; migration counts are typically tens.
- **Already correct — do not flag:**
  - `up()`/`status()` pending computation is Set-based O(n+m) via `migrationId()` (was `Array.includes` O(n·m) before this branch).
  - Per-iteration `loadAsync()` + `saveAsync()` inside the `up()` for-loop is **intentional crash-safety** (state persisted after each applied migration so a mid-run crash never re-runs completed migrations). It is one single-doc `find({}).toArray()` + `replaceOne` upsert per applied migration — not an N+1 to remediate.
  - `readdirSync` + `require(filePath)` in `loadMigrationFiles()` is sync-in-async but boot/CLI-only; CLAUDE.md hot-path rules do not apply. `require` cache retains migration modules for process lifetime — inherent to CJS, accepted.
  - `migrationId()` regex-per-call in filter/find lambdas: nanosecond-scale at tens of migrations; hoisting the regex/invariant is an optional nit, never a graded finding.
- **Re-check on future diffs:** any NEW DB calls added inside the migration loop beyond the load/save pair; any migrate code becoming reachable from a request path; unbounded growth of the state doc handling (state is a single document — fine while migrations stay in the tens/hundreds).

Related: [[swc-cjs-tdz-and-ci-gap]] — new exports here should stay hoisted `export function`s in leaf-ish files (migration-runner.ts imports only fs/path/mongo-state-store; `migrationId` follows this).
