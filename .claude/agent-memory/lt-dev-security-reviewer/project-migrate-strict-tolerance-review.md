---
name: project-migrate-strict-tolerance-review
description: Migrate strict/tolerance semantics — old up() was ALREADY silently tolerant; only down() was weakened; NSC__MIGRATE__STRICT is CLI-only
metadata:
  type: project
---

Reviewed 2026-07-19 (branch `feature/migrate-safe-ts-js-transition`, commit 73a2399). Three non-obvious facts that future reviews of `src/core/modules/migrate/` will otherwise mis-derive:

1. **Pre-change `up()` had NO missing-file detection at all** — recorded migrations whose files were deleted were silently ignored (no warn, no error). The commit-message framing "tolerate instead of hard error" is only true for `down()` (old: `throw` → new: warn + return, CLI exit 0) and for the external `migrate`-package flow. Do NOT report "tolerance newly weakens up()" — for `up()` the diff strictly IMPROVES observability (warn) and adds a new opt-in control (strict). The genuine weakening is the `down()` fail-open (reported MEDIUM SEC-001).

2. **Co-present `foo.ts` + `foo.js` (same `migrationId`, neither recorded) both execute in one `up()` run** — empirically proven with a scratch test (exec count 2; pending list computed once from `completedIds`, no disk-vs-disk dedup). This is PRE-EXISTING under raw-title matching too — not introduced by `migrationId()`. Report as identity-dedup gap (LOW), not as a regression.

3. **`NSC__MIGRATE__STRICT` is consumed ONLY by the CLI's `parseArgs()`** (`cli/migrate-cli.ts`). The programmatic `MigrationRunner` reads only `options.strict`; there is NO `migrate` block in `server-options.interface.ts` / `config.env.ts`. An operator setting the env var while the project runs migrations programmatically gets silent non-enforcement (reported LOW SEC-003).

**Why:** These distinctions (what was already tolerant vs. newly tolerant; pre-existing vs. widened) determine severity classification, and the commit message actively suggests the wrong baseline.
**How to apply:** When re-reviewing migrate-module changes, diff against the ACTUAL old behavior in git (old `up()` had no `missing` check), and verify env-var scope before assuming framework-wide enforcement. If SEC-001 (down() fail-open) got fixed later, verify before re-reporting.
