---
name: project-ci-workflow-security-facts
description: GitHub Actions facts for nest-server workflow reviews — default token is WRITE, no permissions blocks, test-infra action interpolates inputs into shell, evidence gate sharding (DEV-3910) traced sound
metadata:
  type: project
---

Facts verified 2026-10-30 while reviewing DEV-3910 (regression-evidence gate split into `--shard=i/n` matrix jobs):

- `gh api repos/lenneTech/nest-server/actions/permissions/workflow` → `default_workflow_permissions: "write"`, and NO workflow declares `permissions:`. Every job (incl. those running `pnpm install` + vitest) holds a write token; `actions/checkout` persists it in `.git/config`. Pre-existing; only becomes a finding when a diff lets an UNTRUSTED actor's code run in such a job (pull_request_target, workflow_run on fork PRs).
- `.github/actions/test-infra/action.yml` interpolates `${{ inputs.redis-name }}`, `rustfs-name`, `postgres-name`, ports etc. DIRECTLY into `run:` lines. Since DEV-3910 the container names carry `${{ matrix.shard }}`; in `regression-evidence.yml` that comes from `fromJSON(needs.plan.outputs.shards)` built from a `type: choice` input. Safe only because the input is a choice and the actor (workflow_dispatch = write access) could run arbitrary code from their own branch anyway. If the shard source ever becomes free text or reachable by a lower-privileged trigger, this is shell injection.
- Free-text `inputs.args` in `regression-evidence.yml` already lets a dispatcher pass `--list`, `--id=…`, or a `--shard=` that wins over the matrix one (`args.find` takes the FIRST). By design; that workflow's result carries no release authority — `/lt-dev:publish` step 1b reads `gh run list --workflow=publish.yml` conclusions + open `regression-evidence` issues, never job names (so renaming matrix jobs breaks nothing).
- publish.yml evidence: static matrix `[1,2,3,4]` + literal `/4`; issue creation moved to a `regression-evidence-report` job (`needs` + `always() && result == 'failure'`) that runs no repo code. Issue creation proven working (#653, 12.1.0).
- Probe recipe: verify the partition via CLI, not just the spec — `pnpm run --silent check:mutations -- --list --shard=$i/4 | grep -c '^  specs:'` summed over shards must equal the registry length (444 at 12.1.1). Run mutations in your OWN `git worktree` + symlinked node_modules so parallel reviewers never see a mutated live file.

**How to apply:** start any workflow review from these facts; re-run the two `gh` checks since repo settings can change. Related: [[project-check-mutations-tooling-risks]].
