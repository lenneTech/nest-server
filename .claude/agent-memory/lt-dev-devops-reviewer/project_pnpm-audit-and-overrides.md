---
name: project-pnpm-audit-and-overrides
description: Non-obvious pnpm 11 mechanics behind pnpm-workspace.yaml in this repo — built-in 24h minimumReleaseAge, what `pnpm audit --fix` auto-writes, and how check.mjs mis-renders ignored advisories
metadata:
  type: project
---

Mechanics you cannot derive from the repo files alone, verified against the pinned
**pnpm 11.13.1** dist (`~/.cache/node/corepack/v1/pnpm/<version>/dist/pnpm.mjs` — greppable).

**Why:** the 2026-07-30 review of the `auditConfig` / `minimumReleaseAgeExclude` / `minimatch`
change set turned on all three of these, and each one flips a "this entry is inert" verdict.

**How to apply:** check these before calling any `pnpm-workspace.yaml` entry inert, machine-written,
or a silent suppression.

1. **`minimumReleaseAge` has a BUILT-IN 24-hour default** (`"minimum-release-age": 24 * 60` in the
   pnpm dist). So `minimumReleaseAgeExclude` is **never inert** for absence of an explicit
   `minimumReleaseAge:` key — the policy is on by default.

2. **`pnpm audit --fix` auto-writes BOTH the override and the exclude.** `createOverrides()` emits
   the `pkg@>=<floor> <<patched>: <patched>` key shape, and `createMinimumReleaseAgeExcludes()`
   emits `pkg@<minVersion>` entries into `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
   `package.json` has `check:fix` = `… pnpm audit --fix …`, so **an un-commented entry in either
   block is probably machine-generated, not hand-authored** — and the machine picks the floor,
   which is how an over-broad multi-major key gets in past a repo rule that forbids exactly that.

3. **`auditConfig.ignoreGhsas` at pnpm-workspace.yaml TOP LEVEL is correct for pnpm 11** and it does
   gate the exit code (`auditConfig` is in `MIGRATED_PNPM_FIELD_KEYS`; the filter runs before both
   the JSON and table branches of the audit handler). `ignoreCves` was removed in pnpm 11.
   Verify empirically with `pnpm audit` — it prints `Severity: 1 high (1 ignored)` and exits 0.

4. **`scripts/check.mjs` renders ignored advisories as if they were live.** pnpm deliberately leaves
   `metadata.vulnerabilities` UNfiltered (so it can report "(N ignored)" separately) and only filters
   `advisories`. `runAudit()` reads `metadata.vulnerabilities` for its counts but takes `blocking`
   from the exit code — so after any `ignoreGhsas` entry, `pnpm run check` prints a **green check
   next to a live-looking "1 high"**. Not a gate failure; a reporting mismatch. `check.mjs` has no
   notion of pnpm's `ignoredVulnerabilities`.

**Export-shape trap for `minimatch` overrides** (re-usable evidence, empirically tested):
majors **5, 6, 7, 8 are callable CJS** (`module.exports = minimatch`; 6-8 via `dist/cjs/index-cjs.js`,
which also sets `.default`), while **9 and 10 are NOT callable** (`dist/commonjs/index.js`,
`__esModule: true`, no `.default`). So any override key floored below `9.0.0` that targets 10.x
pre-authorizes a `"… is not a function"` runtime break. Floor such keys at `>=9.0.0`.

See [[project-infra-surface]] for the rest of the review surface.
