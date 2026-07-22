---
name: migrate-identity-review
description: Review findings for the migrate extension-agnostic identity feature (branch feature/migrate-safe-ts-js-transition, 2026-07-19) — confirmed dual-extension double-run, down() default change needs guide entry
metadata:
  type: project
---

Reviewed `feat(migrate): extension-agnostic identity + tolerate missing migration files` (post-11.31.0).

**Empirically confirmed (scratch test, deleted after run):** with both `1699-foo.ts` AND `1699-foo.js` in the migrations dir and empty state, `MigrationRunner.up()` executes the SAME migration id TWICE (`.js` first — alphabetical sort) and records two state entries for one id. `pendingMigrations` filter (migration-runner.ts ~line 165) checks `completedIds` computed once before the loop; no in-run dedupe by id. Flagged High — feature itself defines the two files as one identity. If a later diff adds a `seen`-Set dedupe/warn, this is resolved.

**down() default behavior changed** throw → warn+no-op (strict=false default). Needs a migration-guide entry at release time; the 11.30→11.31 guide predates this feature.

**Verified non-issues** (do not re-flag): single-extension strip in `migrationId()` is self-consistent for tsc output (`X.js.ts` → compiled `X.js.js`, both id `X.js`); the `${name}` inside single quotes in the CLI create-template IS interpolated (outer backtick template literal) — not a bug; strict mode does NOT false-positive on the ts→js transition because the missing-check is id-based; raw-env parsing (`NSC__MIGRATE__STRICT`) instead of ConfigService matches the `NSC__MONGOOSE__URI` Docker precedent for the standalone CLI.

**Why:** Future reviews of src/core/modules/migrate/ should not re-derive the double-run analysis or re-flag the verified non-issues.
**How to apply:** When reviewing follow-up diffs in the migrate module, check whether the pending-dedupe and the guide entry landed; note `synchronizedUp` (legacy `migrate`-package path) does NOT get identity normalization — only MigrationRunner/CLI do.
