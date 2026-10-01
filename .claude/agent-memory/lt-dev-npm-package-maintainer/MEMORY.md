# NPM Package Maintainer Memory — nest-server

- pnpm 11 (pinned via `packageManager`); settings + overrides live in `pnpm-workspace.yaml`. Rollback = `git checkout HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml`.
- `pnpm run check` is the final gate; payload work in `src/`/`tests/` is never stashed or touched.

## Index (topic files)
- [Deferred major updates](deferred-major-updates.md) — NestJS 12, vitest 5, graphql 17, TS 7, pnpm, better-auth: why each waits; nodemailer 10 taken as security exception.
- [Override status](nest-server-override-status.md) — per-entry state 2026-10-01 (js-yaml 5.x fires on swagger pin), two-fresh-resolve method.
- [Dependency shape + couplings](nest-server-dependency-shape.md) — why packages sit in deps vs devDeps; mongodb+mongoose; lockstep exact pins.
- [Maintenance gotchas](nest-server-maintenance-gotchas.md) — VS Code port-squat e2e hang, reboot PATH, audit blocks check, nest exec bit, hung install.
- [pnpm 11 override + check gotchas](pnpm11-override-and-check-gotchas.md) — stale lock entries after override edits, targeted `pnpm update --depth Infinity`, `check --no-fix`.
- [Starter downstream step](starter-downstream-maintenance.md) — sync-packages AND check:consumer ignore overrides (bare nodemailer pin), stale copies, safe gate.
