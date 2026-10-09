# NPM Package Maintainer Memory — nest-server

- pnpm 11 (pinned via `packageManager`); settings + overrides live in `pnpm-workspace.yaml`. Rollback = copy back pre-run snapshots taken into the scratchpad — NOT `git checkout HEAD`, which wipes release work when those three files are already dirty (they were on 2026-10-03).
- `pnpm run check` is the final gate; payload work in `src/`/`tests/` is never stashed or touched.

## Index (topic files)
- [Deferred major updates](deferred-major-updates.md) — state 2026-10-09 (post-11.42.9): NestJS 12, vitest 5, graphql 17, TS 7, undici 8, ejs 7, pnpm 12, better-auth, ws lockstep, mongo pair cross-repo, oxfmt 0.72 touches src/; utils 12.0.3 already in fresh trees.
- [Override status](nest-server-override-status.md) — per-entry state 2026-10-09 (19 entries, none changed; handlebars = stale lock, no override), two-fresh-resolve method.
- [Dependency shape + couplings](nest-server-dependency-shape.md) — deps vs devDeps; mongodb+mongoose; AWS trio one version; lockstep exact pins.
- [Maintenance gotchas](nest-server-maintenance-gotchas.md) — nest exec bit; zsh glob traps; `pgrep` self-match; wait out foreign e2e runs AND high load before each gate; hung install; dead Jest reporter + ansi-colors removed 2026-10-09.
- [pnpm 11 override + check gotchas](pnpm11-override-and-check-gotchas.md) — stale lock entries after override edits, targeted `pnpm update --depth Infinity`, `check --no-fix`.
- [Starter downstream step](starter-downstream-maintenance.md) — sync-packages misses section-mismatched pins (supertest, mongodb), overrides, sticky optional peers; fix stale child via parent update; diff vs HEAD not dirty tree (state 2026-10-07: item 16 = 11.42.8 starter run; foreign file red at `format` -> run the tail of check:raw to verify bumps). Item 12: run check:consumer when a dep the starter also declares moves (mongo pair broke it). Item 14: oxfmt follows the framework (vendored core). Item 17: nodemailer lockstep 10.0.16 + starter oxfmt 0.72 divergence.
