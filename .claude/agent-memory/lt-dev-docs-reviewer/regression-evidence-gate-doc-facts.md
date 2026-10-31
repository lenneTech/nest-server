---
name: regression-evidence-gate-doc-facts
description: Verified facts + standing doc traps for the check:mutations evidence gate after DEV-3910 sharding (exit codes, run timings, stale cold-start measurements, issue-body claim vs /lt-dev:publish)
metadata:
  type: project
---

Facts verified 2026-10-30 (DEV-3910, 4-shard matrix in publish.yml + regression-evidence.yml):

- **Exit codes are asymmetric.** Empty selection exits BEFORE sharding, but with **2 only for
  `--since` / `--no-infra`**; an unmatched `--id=<x>` exits **1** ("No mutation matches"). An empty
  SHARD of a non-empty selection returns 0 with "Nothing in this shard". Bad `--shard` → 1. Prose
  that says "an empty selection exits 2" generally is wrong for `--id`. Probe safely with `--list`
  (returns before any source edit): `node scripts/check-mutations.mjs --id=x --shard=2/4 --list`.
- **Timing sources:** 12.1.0 publish run 40879721068 = 58.5 min / 407 mutations (red, lost blocks);
  12.1.1 run 41024203395 = 53 min / 442; on-demand 40922520673 = 54 min / 426. Registry size at a
  release: `git show "${t}":tests/regression-mutations.json` — in zsh write `${t}`, since `$t:t` is
  the tail modifier and silently mangles the path.
- **Stale measurements (pre-existing, not counts):** testing.md "The cost is vitest's cold start"
  still says "~740s ... 444 times" and "777s on a 4-vCPU CI runner" — measured at a ~49-mutation
  registry, now contradicted by the 53-min runs cited two paragraphs above. The count guard in
  regression-evidence.spec.ts bumps "N times" but never the seconds. See [[number-drift-in-tooling-prose]].
- **Issue body overclaims:** publish.yml's auto-issue text says `/lt-dev:publish` "refuses to start a
  new release while the last run of this job is red"; lt-dev `commands/publish.md` step 1b says a red
  run is "**not** a hard stop", only a reporting duty. Pre-existing; flag only if a diff edits that line.
- `/lt-dev:publish` reads `gh run list --workflow=publish.yml` conclusion + open `regression-evidence`
  issues — job names are not read, so renaming/sharding the job does not break it.

**How to apply:** on any diff touching check-mutations.mjs or the evidence workflows, re-probe exit
codes with `--list` and re-derive minutes via `gh run view <id> --json jobs`.
