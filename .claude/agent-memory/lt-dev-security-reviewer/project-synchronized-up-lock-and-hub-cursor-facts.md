---
name: project-synchronized-up-lock-and-hub-cursor-facts
description: DEV-3897 traced sound - synchronizedUp() lock precheck semantics (empty lockCollectionName and SQL lock:false run unlocked by design), not HTTP-reachable; Hub read() no-fallback; upload names 128-bit
metadata:
  type: project
---

DEV-3897 (2026-10-29, branch feature/dev-3897-stateless-review-hardenings) reviewed, zero findings.

- `synchronizedUp()` (now in `migrate/migration-runner.ts`) runs `assertLockableStore()` and then `MigrationRunner.up()`, which takes the lock through `withMigrationLock()`. The two checks are NOT identical. A `MongoStateStore` with `lockCollectionName: ''` passes the precheck (`typeof === 'string'`) and then runs UNLOCKED, because `withMigrationLock` tests `!lockCollectionName`. A `SqlStateStore({ lock: false })`, or `createMigrationStore(sqlUrl, …, '')`, has a `withLock` that runs `fn` unlocked. Both cases are the documented opt-out (`''` disables locking in `createMigrationStore`) and need an operator to configure them, so there is no attacker path. Re-check only if the docs start promising that `synchronizedUp` refuses every unlocked store.
- The precheck is what keeps `synchronizedUp` fail-closed for a store from a second package copy (failing `instanceof`, no `withLock`). `withMigrationLock` alone would run such a store unlocked.
- `synchronizedUp` has no HTTP entry point. The Hub migrations panel builds its own `MigrationRunner` (`core-hub-migrations.service.ts`). Its default directory is `cwd/migrations`, the same as the CLI's `./migrations`.
- `HubBuffer.read()` with Redis configured no longer falls back to the local buffer. Exposure only got smaller. `since` arrives as `Number(query)` on ADMIN-gated routes.
- `multerRandomFileName()` uses `randomBytes(ceil(n/2))`: 128 bits at the default of 32 digits. The extension still comes from `extname(originalname)`. That predates this change and is unchanged.

**How to apply:** do not report the empty-string or `lock:false` cases as a lock bypass in later reviews of the migrate module unless a non-operator can control them.
