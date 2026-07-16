---
name: single-e2e-file-run-gotcha
description: `pnpm run test:e2e -- <file>` does NOT filter to one file — it runs the whole e2e suite, because test:e2e is a nested `pnpm run vitest` alias that swallows the `--` positional
metadata:
  type: project
---

**`pnpm run test:e2e -- tests/stories/foo.e2e-spec.ts` runs the ENTIRE e2e suite, not that one file.** Confirmed empirically 2026-07-15: the command produced `Test Files 52 passed (52) / Tests 1387 passed (1387)`, i.e. every file ran.

**Why:** `package.json` chains aliases — `test:e2e` = `"pnpm run vitest"`, and `vitest` = `"NODE_ENV=e2e vitest run --config vitest-e2e.config.ts"`. The `-- <file>` positional is consumed forwarding into the FIRST `pnpm run` and is lost at the nested `pnpm run vitest` boundary, so the real `vitest run` executes with no file filter.

**How to apply:**
- To run a single e2e file, bypass the double-alias — invoke vitest directly:
  `NODE_ENV=e2e npx vitest run --config vitest-e2e.config.ts tests/stories/foo.e2e-spec.ts`
  (verify the summary shows `Test Files 1 passed (1)` before trusting it as isolated).
- This matters for the test-reviewer/orchestrator flow: when a background `check` run is already exercising the full suite, a naive `test:e2e -- <file>` "quick check" silently launches a SECOND full suite in parallel. That is not catastrophic — per [[e2e-isolation-model]] each RUN gets its own DB (`nest-server-e2e-run-<ts>-p<pid>`), and concurrent full suites are verified safe — but it wastes ~2min and defeats the intent of "run just the one file".
- Observed cleanly here: my run (`...-p31704`) and the concurrent background check (`...-p16805`) used separate run-DBs and the reporter dropped each independently; no interference.
