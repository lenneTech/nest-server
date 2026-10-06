# NPM Package Maintainer Memory — nest-server

- pnpm 11 (pinned via `packageManager`); settings + overrides live in `pnpm-workspace.yaml`. Rollback = copy back pre-run snapshots taken into the scratchpad — NOT `git checkout HEAD`, which wipes release work when those three files are already dirty (they were on 2026-10-03).
- `pnpm run check` is the final gate; payload work in `src/`/`tests/` is never stashed or touched.

## Index (topic files)
- [Deferred major updates](deferred-major-updates.md) — state 2026-10-06: NestJS 12, vitest 5, graphql 17, TS 7, undici 8, ejs 7, pnpm, better-auth, ws/mongodb lockstep, graphql-tools refresh.
- [Override status](nest-server-override-status.md) — per-entry state 2026-10-06 (19 entries; hono raised 4th run; graphql-tools/utils trails by design), two-fresh-resolve method.
- [Dependency shape + couplings](nest-server-dependency-shape.md) — deps vs devDeps; mongodb+mongoose; AWS trio one version; lockstep exact pins.
- [Maintenance gotchas](nest-server-maintenance-gotchas.md) — nest exec bit; port reservation no longer needed (supertest 7.3.1, verified 2026-10-06); zsh glob traps; `pgrep` self-match; scratch dedupe; hung install.
- [pnpm 11 override + check gotchas](pnpm11-override-and-check-gotchas.md) — stale lock entries after override edits, targeted `pnpm update --depth Infinity`, `check --no-fix`.
- [Starter downstream step](starter-downstream-maintenance.md) — sync-packages misses section-mismatched pins (supertest, mongodb), overrides, sticky optional peers; fix stale child via parent update; diff vs HEAD not dirty tree (state 2026-10-06, 11.42.4 done).
