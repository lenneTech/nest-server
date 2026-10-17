# NPM Package Maintainer Memory — nest-server

- pnpm 11 (pinned via `packageManager`); settings + overrides live in `pnpm-workspace.yaml`. Rollback = copy back pre-run snapshots taken into the scratchpad — NOT `git checkout HEAD`, which wipes release work when those three files are already dirty (they were on 2026-10-03).
- `pnpm run check` is the final gate; payload work in `src/`/`tests/` is never stashed or touched.

## Index (topic files)
- [Deferred major updates](deferred-major-updates.md) — state 2026-10-17 (pre-11.42.15; undici 7.30.1 security, nodemailer, brevo, AWS, bullmq, oxlint moved): NestJS 12, vitest 5 + 4.1.12 (source comments), graphql 17, TS 7, undici 8, ejs 7, pnpm 12, better-auth 1.7.10 lock-step, express 5.3 + ws lockstep, utils 12.1 + oxfmt 0.73 after the payload.
- [Override status](nest-server-override-status.md) — per-entry state 2026-10-17 (19 entries; qs 6.16.1 + undici 7.30.1 raised; utils 12.1.0 due, fresh resolve already has it), two-fresh-resolve method.
- [Dependency shape + couplings](nest-server-dependency-shape.md) — deps vs devDeps; mongodb+mongoose; AWS trio one version; lockstep exact pins.
- [Maintenance gotchas](nest-server-maintenance-gotchas.md) — repo-level advisories invisible to audit (read runtime release notes); oxlint silent when clean; nest exec bit; zsh glob traps; `pgrep` self-match; wait out foreign e2e runs AND high load before each gate; hung install; dead Jest reporter + ansi-colors removed 2026-10-09.
- [pnpm 11 override + check gotchas](pnpm11-override-and-check-gotchas.md) — stale lock entries after override edits, targeted `pnpm update --depth Infinity`, `check --no-fix`.
- [Starter downstream step](starter-downstream-maintenance.md) — overrides are never raised by sync-packages/check:consumer; sticky optional peers; fresh-lock swaps; judge vs HEAD. Item 23 (2026-10-17): fresh resolve has 2 @graphql-tools/utils copies, raise to 12.1.0 in both repos.
