# NPM Package Maintainer Memory — nest-server

- pnpm 11 (pinned via `packageManager`); settings + overrides live in `pnpm-workspace.yaml`. Rollback = copy back pre-run snapshots taken into the scratchpad — NOT `git checkout HEAD`, which wipes release work when those three files are already dirty (they were on 2026-10-03).
- `pnpm run check` is the final gate; payload work in `src/`/`tests/` is never stashed or touched.

## Index (topic files)
- [Deferred major updates](deferred-major-updates.md) — state 2026-10-17 pre-11.42.16 (vitest 4.1.12 on repo-only advisories, oxfmt 0.73 taken): NestJS 12, vitest 5, graphql 17, TS 7, undici 8, ejs 7, pnpm 12, better-auth 1.7.10 lock-step, express 5.3 + ws lockstep, js-yaml 5.5.
- [Override status](nest-server-override-status.md) — per-entry state 2026-10-17 pre-11.42.16 (19 entries; utils raised to 12.1.0 + schema/merge refreshed = one copy), two-fresh-resolve method.
- [Dependency shape + couplings](nest-server-dependency-shape.md) — deps vs devDeps; mongodb+mongoose; AWS trio one version; lockstep exact pins.
- [Maintenance gotchas](nest-server-maintenance-gotchas.md) — repo-level advisories invisible to audit (query repo security-advisories for every update you SKIP too); oxlint silent when clean; nest exec bit; zsh glob traps; `pgrep` self-match; wait out foreign e2e runs AND high load before each gate; hung install; dead Jest reporter + ansi-colors removed 2026-10-09.
- [pnpm 11 override + check gotchas](pnpm11-override-and-check-gotchas.md) — stale lock entries after override edits, targeted `pnpm update --depth Infinity`, `check --no-fix`.
- [Starter downstream step](starter-downstream-maintenance.md) — overrides are never raised by sync-packages/check:consumer; sticky optional peers; fresh-lock swaps; judge vs HEAD. Item 24 (2026-10-17): starter must raise utils override to 12.1.0 by hand; vitest 4.1.12 + oxfmt 0.73 follow via update.
