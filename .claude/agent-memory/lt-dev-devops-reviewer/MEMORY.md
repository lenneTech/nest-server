# lt-dev-devops-reviewer Memory

## Review Workflow
- [Review uncommitted worktree](feedback_review-uncommitted-worktree.md) — releases reviewed via `git diff HEAD` + untracked files on `develop`; pipeline already GREEN, static review only.

## Project Context
- [Infra surface](project_infra-surface.md) — DOES ship reference Docker infra (corrected); compose lives in lt-monorepo; no memory limits, no prod NODE_OPTIONS, `pnpm audit` not in CI.
- [PID-1 signal contract](project_pid1-signal-contract.md) — node is PID 1 via `exec`; `enableShutdownHooks()` never called, so remove-listener+re-raise is swallowed in-container.
