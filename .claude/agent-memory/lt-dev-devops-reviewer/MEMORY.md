# lt-dev-devops-reviewer Memory

## Review Workflow
- [Review uncommitted worktree](feedback_review-uncommitted-worktree.md) — releases reviewed via `git diff HEAD` + untracked files on `develop`; pipeline already GREEN, static review only.

## Project Context
- [Infra surface](project_infra-surface.md) — no Docker/CI-YAML infra; review surface = check.mjs, vitest configs, pnpm overrides, bin/migrate.js. CI just runs `prepublishOnly`.
