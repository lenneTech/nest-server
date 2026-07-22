---
name: migrate-module-test-coverage
description: Coverage state of src/core/modules/migrate after the 2026-07 identity/strict review — down() paths and CLI parseArgs untested; testability facts that make closing them cheap
metadata:
  type: project
---

Migrate-module test coverage as of the `feature/migrate-safe-ts-js-transition` review (2026-07-19, commit 73a2399). Verify against current specs before reusing — remediation may have landed.

**Untested then:** all three `down()` paths touched by the identity change (cross-extension rollback lookup; missing-file tolerate; missing-file strict), `up()`'s own no-re-run property (only pinned via `status()`'s PARALLEL implementation of the same identity logic — the two do not share code), and `migrate-cli.ts` `parseArgs` (`--strict`, `NSC__MIGRATE__STRICT`).

**Why:** the spec author stopped at status()/up()-tolerance; down() looked helper-coupled and parseArgs is unexported.

**How to apply — testability facts that survive refactors only if re-verified:**
- `down()` missing-file branches return/throw BEFORE `_startMigration()`; the dynamic `import('./helpers/migration.helper')` is side-effect-free at import time, and `_endMigration()` with zero `getDb()` calls is `Promise.all([])` — so ALL down() paths work with the existing fakeStore+mkdtemp pattern, no helper mocking.
- Repo precedent for "CLI is untestable": `bin/migrate.js` exports `resolveCliPath` behind the `require.main` guard purely for its spec — exporting `parseArgs` the same way is the established answer, not a subprocess test.
- `MigrationSet` requires `up: (done?) => void`; a stub returning only `{ migrations }` needs `as unknown as MongoStateStore`, which disables drift checking — prefer a valid MigrationSet + `satisfies Pick<MongoStateStore, 'loadAsync' | 'saveAsync'>`.
- `status()` ignores `strict` although the CLI `list` command passes it (dead config wiring) — flagged informational, may still exist.
