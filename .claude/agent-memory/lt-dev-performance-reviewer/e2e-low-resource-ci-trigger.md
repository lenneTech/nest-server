---
name: e2e-low-resource-ci-trigger
description: The e2e load signal fires on EVERY GitHub CI build (self-induced by the unit step); an A/B on hosted runners measured the 2-worker cap at +25 % (normalised) e2e time, so the cap is skipped there via RUNNER_ENVIRONMENT=github-hosted.
metadata:
  type: project
---

Measured 2026-10-11 from three `build.yml` runs (11.42.8-11.42.10), public-repo `ubuntu-latest`
(4 vCPU, so vitest's run-mode default is `availableParallelism - 1` = 3 workers):

| Fact | Value |
|------|-------|
| `[e2e] low-resource mode: machine is busy` on the runner | **3 of 3 runs**, load 0.84 / 0.92 / 0.91 per core (threshold 0.7) |
| Gap between the unit run's summary and that line | ~0.9 s - the load is the pipeline's own `vitest:unit` (`test:ci` = unit `&&` e2e), not contention |
| e2e wall / summed worker time (transform+setup+import+tests) | 165-173 s / 483-508 s -> **2.93-2.94 workers busy on average** |
| Low-resource worker value on 4 vCPU | `max(2, floor(4/3))` = 2 |

**Why:** until the `maxWorkers` fix the cap was `poolOptions.forks.maxForks`, which Vitest 4
discards, so this false positive only raised timeouts. Once the cap binds, CI loses 1 of 3 workers.
The worker-time ceiling (~+80 s, ~+47 %) was only an upper bound, so it was MEASURED on 2026-10-11
with a temporary branch (matrix `CHECK_LOW_RESOURCE` '0'/'1' x 3, each job its own hosted VM):

| Variant | e2e wall (3 runs) | mean | e2e / unit step on the same runner |
|---------|-------------------|------|------------------------------------|
| 3 workers ('0') | 169, 108, 122 s | 133 s | 2.72 / 3.14 / 3.21 (mean 3.02) |
| 2 workers ('1') | 211, 197, 185 s | 198 s | 3.83 / 3.71 / 3.80 (mean 3.78) |

+49 % raw, +25 % normalised for runner speed (the unit step on the same VM is the speed proxy;
hosted runners differ by ~1.8x between VMs). Every capped run was slower than every uncapped one.

**Resolution:** `vitest-e2e.config.ts` skips the worker cap when the load signal is the ONLY
trigger AND `RUNNER_ENVIRONMENT === 'github-hosted'` (raised timeouts stay). Keyed on that, not
on `CI`: a shared GitLab runner sets `CI` but has real contention (2.6-5.0/core measured in
lt-crm, several jobs per host) and must keep the cap. Forced mode (check:mutations lanes) and an
active slot still cap. Mutation `e2e-low-resource-cap-ci-self-load`.

**How to apply:** any change that makes low-resource mode DO something (worker cap, slower
polling, etc.) must be checked against CI, because the load signal there is always on. Get the
evidence with `gh run view <id> --log | grep 'low-resource mode'` and the vitest `Duration (...)`
breakdown. An effect estimate from worker-time accounting is a ceiling, not a measurement: a
saturated pool also speeds up per file when a worker is removed. For a real number, a temporary
branch with a measurement-only workflow (the other push workflows deleted in that commit) gives
6 parallel jobs in ~10 min; it needs the owner's OK because the repo is public.
Related: [[check-mutations-parallelism-costs]].
