---
name: project_dev-3897-stateless-hardenings
description: DEV-3897 review (2026-10-29) — synchronizedUp now runs MigrationRunner; a RELATIVE migrationsDirectory failed MODULE_NOT_FOUND (High, fixed in the branch); Hub cursor-keeping read, randomBytes upload names verified sound
metadata:
  type: project
---

Branch feature/dev-3897-stateless-review-hardenings, commit 2f3bf16, reviewed 2026-10-29.

**Reported (High), fixed in the same branch:** `MigrationRunner` loaded each file with
`createRequire(cwd/package.json)(path.join(dir, file))`, and `path.join('./migrations', f)` yields `migrations/f.js`,
which require() treats as a PACKAGE name -> `MODULE_NOT_FOUND` for the `'./migrations'` the docs show. Since the fix
the runner constructor `path.resolve()`s `migrationsDirectory` (mutation `migration-runner-relative-directory`,
`tests/unit/migration-runner-relative-directory.spec.ts`), so a relative directory is fine from 12.1.1 on.

**Verified, do not re-flag:**
- synchronizedUp always threw since 11.4.0 (`promisify(loadedSet.up)` on a plain state doc) — nobody relied on it.
- No nested lock: assertLockableStore checks only; MigrationRunner.up() takes the lock once. No import cycle
  (mongo-state-store imports nothing from migration-runner). `MigrationOptions` stays assignable to
  `SynchronizedUpOptions` (tsc probe).
- Hub `read()` on failed shared read returns `{ cursor: since ?? -1, dropped: -1, entries: [] }`; the logs client
  re-sends `since=-1` and gets the whole window on recovery; traces/mailbox/queries panels re-fetch fully.
- Pre-existing, NOT this diff: MigrationRunner `await migration.up()` breaks callback-style (`up(next)`) migrations,
  which the README still documents.

Related: [[project_migrate-identity-review]], [[project_hub-module]].
