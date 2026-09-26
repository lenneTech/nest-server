# NPM Package Maintainer Memory — nest-server

- pnpm 11 (pinned via `packageManager`); settings + overrides live in `pnpm-workspace.yaml`. Rollback = `git checkout HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml`.
- `pnpm run check` is the final gate; payload work in `src/`/`tests/` is never stashed or touched.

## Index (topic files)
- [Deferred major updates](deferred-major-updates.md) — NestJS 12, vitest 5, graphql 17, graphql-upload 18, TS 7, pnpm, better-auth lock-step: why each waits.
- [Override status](nest-server-override-status.md) — per-entry state 2026-09-26, key-is-a-pin trap, two-fresh-resolve method, UNUSED semantics.
- [Dependency shape + couplings](nest-server-dependency-shape.md) — why packages sit in deps vs devDeps; mongodb+mongoose; lockstep exact pins.
- [Maintenance gotchas](nest-server-maintenance-gotchas.md) — check:overrides TDZ bug (fixed 11.41.4), hung pnpm install, nest exec bit, oxfmt/oxlint evaluation, depcheck false positives.
- [pnpm 11 override + check gotchas](pnpm11-override-and-check-gotchas.md) — stale lock entries after override edits, targeted `pnpm update --depth Infinity`, `check --no-fix`.
