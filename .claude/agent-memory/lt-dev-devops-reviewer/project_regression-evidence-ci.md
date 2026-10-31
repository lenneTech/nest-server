---
name: project-regression-evidence-ci
description: How the non-blocking regression-evidence gate (check:mutations) runs in CI since DEV-3910 sharding, what consumes its result, and proof recipes that avoid false alarms
metadata:
  type: project
---

Since DEV-3910 (2026-10-30, branch `feature/dev-3910-…`), `check:mutations` runs as a 4-shard matrix in
`publish.yml` (`--shard=${{ matrix.shard }}/4`, `fail-fast: false`) and a `plan`-job-driven matrix in the
dispatch-only `regression-evidence.yml` (`shards` choice input → `fromJSON(needs.plan.outputs.shards)`).
The issue-opening step lives in a separate `regression-evidence-report` job
(`needs: regression-evidence`, `if: always() && needs.regression-evidence.result == 'failure'`).

**Why:** one runner took 53 min for 442 mutations at 12.1.1; the 30-min trigger in testing.md was crossed.

**How to apply (facts verified 2026-10-30, re-check before relying on them):**
- `/lt-dev:publish` preflight reads only the publish.yml RUN conclusion + open `regression-evidence`
  issues — nothing parses job NAMES, so renaming the evidence job is safe.
- Repo default `GITHUB_TOKEN` is `write` (`gh api repos/lenneTech/nest-server/actions/permissions/workflow`),
  no `permissions:` block in either workflow; issue #653 (12.1.0) was created by `app/github-actions`,
  so github-script issue creation works without an explicit block.
- `seq -s, 1 N` on macOS (BSD) emits a TRAILING comma (`[1,2,]` = invalid JSON); GNU seq on
  ubuntu-latest does not. The plan job therefore uses `seq 1 "$SHARDS" | paste -sd, -` (portable,
  changed in the DEV-3910 review). For any other `seq -s,` line, simulate in
  `docker run --rm --network none ubuntu:24.04`, never on the Mac, or you report a false Critical.
- Postgres/MySQL/MariaDB container names are NOT passed to `.github/actions/test-infra` (defaults
  `ci-*`) and teardown removes only Redis + RustFS — pre-existing, harmless on GitHub-hosted runners.
- No YAML parser in node_modules and no pyyaml; `ruby -ryaml` works for structural parsing.
- Empty shard of a non-empty selection exits 0; empty selection exits 2/1 before sharding.
- Partition proof without executing anything: `node scripts/check-mutations.mjs --list --shard=i/4`
  for i=1..4 prints `--shard=i/4: N of M selected mutations`; the N must sum to M (12.2.0 review,
  2026-11-01: 119+119+118+118 = 474). Selection is env-independent (no auto `--no-infra`), so
  every shard VM computes the same split.
- Merged to develop as #662 and first shipped with 12.2.0. The 12.2.0 infra review found nothing.

Related: [[project-infra-surface]], [[feedback-review-uncommitted-worktree]].
