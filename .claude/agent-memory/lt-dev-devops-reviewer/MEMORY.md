# lt-dev-devops-reviewer Memory

## Review Workflow
- [Review uncommitted worktree](feedback_review-uncommitted-worktree.md) — releases reviewed via `git diff HEAD` + untracked files on `develop`; pipeline already GREEN, static review only.

## Project Context
- [Infra surface](project_infra-surface.md) — ships reference Docker infra; `pnpm audit` IS a blocking CI gate; tini + shutdown hooks landed in 11.32.0; compose lives in lt-monorepo.
- [pnpm audit & overrides mechanics](project_pnpm-audit-and-overrides.md) — built-in 24h `minimumReleaseAge`, what `pnpm audit --fix` auto-writes, check.mjs mis-renders ignored advisories, minimatch export-shape trap.
- [PID-1 signal contract](project_pid1-signal-contract.md) — SUPERSEDED by 11.32.0 (tini + `enableShutdownHooks()`); kept so the stale conclusion is not re-derived.
