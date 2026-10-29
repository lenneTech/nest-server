---
name: migrate-programmatic-runner-doc-traps
description: Two runtime traps found in migrate-module doc examples — a relative migrationsDirectory (fixed in 12.1.1, the runner resolves it), and MongoStateStore.loadAsync() returning {} on first run (still a trap)
metadata:
  type: project
---

Two facts about `src/core/modules/migrate/` that every doc example must survive, verified 2026-10-29 (DEV-3897 review):

1. **A relative `migrationsDirectory` broke every PROGRAMMATIC runner before 12.1.1.** `MigrationRunner.loadMigrationFiles()`
   loads each file with `createRequire(<cwd>/package.json)(path.join(dir, file))`, and `path.join('./migrations', 'x.js')` is
   `migrations/x.js` — a BARE specifier → `MODULE_NOT_FOUND` as soon as one migration file exists (an empty dir passes, so a
   quick probe looks green). Fixed in the DEV-3897 review: the runner constructor now `path.resolve()`s the directory. A doc
   example with `'./migrations'` is correct from 12.1.1 on; for an older version it throws.

2. **`MongoStateStore.loadAsync()` returns `{}` on a fresh database** (nodepit compatibility) although `MigrationSet.migrations`
   is typed non-optional — `set.migrations.length` compiles and throws `TypeError`. `MigrationRunner.up()` saves no state when
   nothing is pending, so the state stays `{}`.

**Why:** DEV-3897's acceptance criterion was "migrate docs no longer point at a function that throws"; both traps survived
into the fix's own examples while the e2e test passed (it uses an absolute tmp dir). Both were fixed in the review.

**How to apply:** on any migrate-doc diff, run the example for real: tsx script in the scratchpad, imports by ABSOLUTE path
(`.../src/core/modules/migrate/index.js`, `.../node_modules/mongodb/lib/index.js` — the scratchpad cannot resolve bare
packages), `cd` into a scratch dir containing `migrations/<ts>-x.js`, DB name with a `test` segment, drop it in `finally`.
Also note: the README's callback-style example migration (`up(next)` + `callbackify`) throws under `MigrationRunner`, which
calls `up()` without a callback — pre-existing, CLI too. See [[executable-doc-recipes]].
