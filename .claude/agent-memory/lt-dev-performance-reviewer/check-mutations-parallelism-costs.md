---
name: check-mutations-parallelism-costs
description: Measured costs behind the regression-evidence gate's parallel mode (npx vs .bin spawn, git worktree add, worktree size) and the CHECK_LOW_RESOURCE coupling that invalidates its cited 1.87x speedup.
metadata:
  type: project
---

Measured on this repo (12-core laptop, 2026-08-22), for `scripts/check-mutations.mjs`:

| Cost | Measured |
|------|----------|
| `npx vitest --version` spawn | **239 ms** |
| `node_modules/.bin/vitest --version` spawn | **41 ms** |
| `git worktree add --detach` (this repo) | **~190 ms**, 9.1 MB, 832 files |
| Registry size | **51** mutations, **21** unit-only / **30** e2e |

**Why:** the gate's own comments quote a sizing model and a speedup, and both need
these numbers to be checkable. Two of the comments are already stale against the
registry (they say "49 mutations" / "the 20 mutations"); the runtime notes compute
their counts dynamically and are fine.

**How to apply:**

1. **The `npx` → `.bin` switch is real but small.** ~198 ms x 51 = ~10 s of a
   ~740 s run (1.4%). Do not let it be cited as the reason parallel mode got faster.
2. **Worktree setup is NOT a meaningful cost** (~0.8 s for 4 lanes). Any guard in
   `planJobs()` justified by "worktree setup costs real time" — currently
   `mutationCount < requested * 2` → `jobs = floor(count/2)` — is over-conservative:
   at 4 e2e mutations it drops from 4 lanes to 2, trading ~20 s of wall clock to
   avoid ~0.4 s of setup.
3. **The cited "744s -> 399s (1.87x) at 4 jobs" predates `CHECK_LOW_RESOURCE`
   defaulting to `'1'` when `jobs > 1`.** The old `specEnv` forced it to `'0'`, so
   the measurement was taken with `maxForks` uncapped and 30 s timeouts. The number
   describes a configuration the code no longer produces — re-measure before
   quoting it, and before tuning the `Math.min(4, Math.max(2, floor(cores/3)))`
   formula off it.
4. **`CHECK_LOW_RESOURCE_FORKS` is not set per lane.** `vitest-e2e.config.ts`
   computes `max(2, floor(CORES/3))` from TOTAL machine cores, so on 12 cores each
   of 4 lanes independently sizes to 4 forks = 16 forks on 12 cores. If lane
   over-subscription is ever investigated, this is the first place to look.

Related: [[swc-cjs-tdz-and-ci-gap]] (the other check that only the tooling catches).
