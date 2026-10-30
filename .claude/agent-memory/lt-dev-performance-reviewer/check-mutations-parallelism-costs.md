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
4. **`CHECK_LOW_RESOURCE_FORKS` IS set per lane now** (`max(1, floor(cores/(3*jobs)))`),
   and since the 2026-10 switch from `poolOptions.forks.maxForks` (discarded by
   Vitest 4) to `maxWorkers` it actually binds: 1 worker per lane at 12 cores/4 jobs
   and at 4 vCPU/2 jobs. Wall-clock effect verified ~nil: most mutations (125 of 194 on 2026-10-11) are
   unit-only (vitest.config.ts reads no LOW_RESOURCE knob), and only 2 of 69 e2e
   mutations name 2 spec files (seconds of serialization each).

Related: [[swc-cjs-tdz-and-ci-gap]] (the other check that only the tooling catches).

## CI cost distribution (measured 2026-10-30, 12.1.1 publish run 41024203395, DEV-3910)

Per-mutation durations are reconstructible from the job log: lanes pull from a shared
cursor in registry order, so with `jobs` lanes mutation k starts at the timestamp of
progress line `[k-jobs+1/N]` and ends at the line naming its id (k >= jobs; the first
`jobs` start at "Running N mutations across"). 442 mutations, 2 lanes, 4 vCPU:
6169 lane-s, 3102 s wall. Unit median 0.8 s (sum 824 s); e2e median 5.8 s (sum 5345 s).

**The cost is four timeout-driven outliers, not cold start:** `gridfs-upload-source-error-unhandled`
1082 s, `s3-body-stream-error-unguarded` 722 s (both `file-upload-stream-error.e2e-spec.ts`),
`sql-pool-guard-unlistened-checkout-error` 550 s, `ws-connection-never-revalidated` 341 s = 44 %
of all lane-seconds. Deterministic: a mutation that makes a test HANG costs
(1 + `retry: 2`) x low-resource `testTimeout` 60 s = 180 s per red test (6 red -> 1080 s).

**How to apply:** 4 shards (`shardMutations`, unit/e2e round-robin) -> simulated slowest
shard 18.2 min + ~76 s job setup (balance 18.2 / 12.4 / 15.5 / 9.3 min). The gridfs mutation
alone floors any shard count at ~18 min (8 shards: still 18.1) — raising n cannot go below it;
only a shorter hang (timeout/retry for that spec) can. Re-check this table when the registry grows.
