---
name: migrate-cli-exit-guard-dead-through-bin-shim
description: The `require.main === module` block in migrate-cli.ts NEVER runs through the shipped `migrate` bin — bin/migrate.js imports and calls main(), so any CLI process-lifecycle claim must be checked against the shim
metadata:
  type: project
---

`src/core/modules/migrate/cli/migrate-cli.ts` guards its CLI bootstrap with `if (require.main === module)`.
**That block is dead code on every shipped invocation path.** `bin/migrate.js` — which is BOTH declared bins
(`migrate` and `nest-migrate` in `package.json`) — ends with:

```js
const { main } = require(cliPath);
main();
```

So `require.main` is `bin/migrate.js`, `module` is `migrate-cli.js`, the comparison is **false** (verified
empirically), and anything inside that block — `process.exit(0)`, `process.exit(1)`, the `.catch()` — never
fires. `bin/migrate.js` supplies no `.catch()` of its own, so a failure there is an unhandled rejection
rather than the exit code the guard block promises.

`docker-entrypoint.sh` reaches the CLI through this shim in **both** consumption modes
(`$MIGRATE_BIN` = `/app/node_modules/.bin/migrate` in npm mode, `node $DIST/bin/migrate.js` in vendor mode),
so the container path is covered by the shim too, not by the guard.

**Why:** A 2026-07-30 change first put its exit inside that guard, with a docblock naming the exact scenario
it fixes — *"a container entrypoint of the shape `migrate up && node main.js` never reaches the server at
all"*. That scenario runs through `bin/migrate.js`, i.e. the one path the guard does not reach, so the fix
would have shipped as a claim rather than a behaviour.

**Status as of 11.32.4 (RESOLVED — do not re-report):** the exit moved OUT of the guard into an exported
`runCli()`, and `bin/migrate.js` now calls `cli.runCli || cli.main` with its own `.catch()`. The guard block
still exists and is still dead through the shim — it covers only a direct `node migrate-cli.js` — but nothing
load-bearing lives inside it any more, and `migrate-cli.ts` says so in its own docblock. The structural trap
below is unchanged; only this one instance is closed.

**How to apply:** Whenever a diff touches CLI process lifecycle (exit codes, signal handling, "runs only when
executed directly"), open `bin/migrate.js` before grading the claim. State in the review whether the change
reaches the shim path, the direct-`node` path, or both. Same discipline as
[[migration-guide-behavior-change-count-trap]]: derive the behaviour from the source, never from the comment
that describes it. Related: [[comment-density-baseline]].
