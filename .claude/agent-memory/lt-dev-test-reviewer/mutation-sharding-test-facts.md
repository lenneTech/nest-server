---
name: mutation-sharding-test-facts
description: DEV-3910 check:mutations --shard=i/n review (2026-10-30) — what mutation-sharding.spec.ts pins and what it does not, how to probe the split cheaply, and the BSD-seq trap for executing workflow shell lines in a unit spec
metadata:
  type: project
---

`check:mutations --shard=i/n` (DEV-3910) splits the evidence gate across CI matrix jobs. First review 2026-10-30.

**Cheap end-to-end probe of the split, through main():** `--list --shard=i/n` for every i, collect the id lines
(`grep -E '^[a-z0-9][a-z0-9-]*$'`), sort, diff against `--list` alone. Read-only, seconds per count. 444/444, no
duplicates, for n = 1–8, 16, 64. This covers main()'s wiring, which the spec never imports (it tests only the pure
`shardMutations` / `parseShard`).

**Pinned by tests/unit/mutation-sharding.spec.ts (probed red in a clone):** dropping `fail-fast: false` in either
workflow, the report job's `if:` loosened to `failure()`, its `needs:` removed. The publish.yml regexes see only
the evidence job (the `publish` job's `strategy:` has no fail-fast line).

**Plan job (found unpinned in the DEV-3910 review, fixed before merge):** regression-evidence.yml's `plan` job now
writes `shards=[$(seq 1 "$SHARDS" | paste -sd, -)]` (portable — BSD `seq -s,` on macOS leaves a trailing comma), and
the spec pins both output lines STATICALLY (the unit suite also runs on Windows, without bash); mutation
`evidence-plan-lists-fewer-shards` (`seq 1` → `seq 2`) proves it red. Re-check that the pin still exists if the plan
job is ever rewritten.

**Not broken by the matrix rename:** `/lt-dev:publish` step 1b reads the publish.yml RUN conclusion
(`gh run list --workflow=publish.yml`) plus open `regression-evidence` issues, never a job name. publish.yml has no
`permissions:` key, so moving the issue step into its own job kept its token scope.

Related: [[scratch-copy-mutation-check]], [[check-gate-coverage-blind-spots]].
