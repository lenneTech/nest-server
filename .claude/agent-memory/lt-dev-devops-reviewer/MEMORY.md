# lt-dev-devops-reviewer Memory

## Review Workflow
- [Review uncommitted worktree](feedback_review-uncommitted-worktree.md) — releases reviewed via `git diff HEAD` + untracked files on `develop`; pipeline already GREEN, static review only.

## Project Context
- [Infra surface](project_infra-surface.md) — reference Docker infra; blocking `pnpm audit`; tini (11.32.0); compose in lt-monorepo; 12.0.0 = ESM package + CJS scope islands, packed-tarball migrate proof.
- [pnpm audit & overrides mechanics](project_pnpm-audit-and-overrides.md) — 24h `minimumReleaseAge` enforced even on frozen installs (how to prove it, verdict cache trap), `audit --fix` side effects, check.mjs mis-render.
- [Postgres test infra](project_postgres-test-infra.md) — DEV-3829 Postgres container: TCP readiness rationale, side-effect-free proof recipes for action + script.
- [Without-MongoDB gate](project_without-mongodb-gate.md) — 12.1.0 optional Mongo peers; prove dist/--package gates without rebuilding dist or a DB; DROP-DATABASE hook.
- [Cross-repo patch hoist contract](project_cross-repo-patch-hoist-contract.md) — starter `patchedDependencies` need CLI ≥1.50.4 (older drops it, init breaks); e2e Docker proof recipe.
- [Template image smoke + CI tokens](project_starter-image-smoke-and-ci-tokens.md) — app image OOMs on `/` without API URL (pre-existing); which CI passes GITHUB_TOKEN to the guards.
- [PID-1 signal contract](project_pid1-signal-contract.md) — SUPERSEDED by 11.32.0 (tini + `enableShutdownHooks()`); kept so the stale conclusion is not re-derived.
