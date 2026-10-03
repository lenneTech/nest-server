# NPM Package Maintainer Memory — nest-server

- pnpm 11 (pinned via `packageManager`); settings + overrides live in `pnpm-workspace.yaml`. Rollback = copy back pre-run snapshots taken into the scratchpad — NOT `git checkout HEAD`, which wipes release work when those three files are already dirty (they were on 2026-10-03).
- `pnpm run check` is the final gate; payload work in `src/`/`tests/` is never stashed or touched.

## Index (topic files)
- [Deferred major updates](deferred-major-updates.md) — state 2026-10-03: NestJS 12, vitest 5, graphql 17, TS 7, pnpm, better-auth, ws/mongodb lockstep: why each waits.
- [Override status](nest-server-override-status.md) — per-entry state 2026-10-03 (hono raised 3 runs running), two-fresh-resolve method.
- [Dependency shape + couplings](nest-server-dependency-shape.md) — deps vs devDeps; mongodb+mongoose; AWS trio one version; lockstep exact pins.
- [Maintenance gotchas](nest-server-maintenance-gotchas.md) — check nest exec bit + reserve VS Code ports BEFORE the gate; dead husky; scratch dedupe; hung install.
- [pnpm 11 override + check gotchas](pnpm11-override-and-check-gotchas.md) — stale lock entries after override edits, targeted `pnpm update --depth Infinity`, `check --no-fix`.
- [Starter downstream step](starter-downstream-maintenance.md) — sync-packages + check:consumer ignore overrides (bare nodemailer pin), stale copies, sticky optional peer, dedupe, safe gate.
