---
name: project-check-overrides-pnpm11-outage-shapes
description: check-overrides.mjs vs pnpm 11 audit failures — 926b691 fixed the false "ok" but its early exit skips the GitHub-based suppression/stranded checks (CI exit 0 in starter + lt-monorepo); pnpm 11 registry env-var facts. Measured 2026-10-06 with stubs.
metadata:
  type: project
---

Measured 2026-10-06 (waves 2b + 2c) on pnpm 11.13.1 / 11.14.0, the versions the Grund-Repos pin:

- **Every pnpm 11 audit failure is an `{"error":{code,message}}` envelope on stdout, exit 1**: 502,
  401, invalid JSON, `[]`/`null`/non-map bodies (`ERR_PNPM_AUDIT_BAD_RESPONSE`), refused
  (`"pnpm"`/`fetch failed`), hang or stalled body (`code: 23`, "aborted due to timeout"). Only a
  `200 {}` answer gives the exit-0 all-zero report (the "ambiguous" shape).
- **Registry env:** pnpm 11 ignores `npm_config_registry`; honours `pnpm_config_registry` AND
  `PNPM_CONFIG_REGISTRY`, and when both are set it prefers the UPPERCASE one (guards read lowercase
  first — only matters if both are set to different hosts; below the bar).
- **Wave 2b SEC-001** (envelope read as "0 advisories ... ok") is FIXED in nest-server 926b691 and
  ported; all four copies are AST-identical (compare with a TS-AST canonical walk, not `diff`:
  nuxt's copy is reformatted).
- **Wave 2c finding — FIXED in 40073c2 (11.42.6), ports re-verified 2026-10-06:** the three
  no-usable-audit paths now set `auditUnavailable` and continue; the run ends in a WARN counting
  verified suppressions. Re-verified with 5 fixtures (fixed suppression, NOT READ, backport residual,
  second-consumer residual, valid residual) x 10 failure modes x 4 copies: every defect exits 1,
  the valid residual ends WARN exit 0, never "ok". Original description of the defect:
  the fix's new block `process.exit(0)`s BEFORE `advisoryStatus(suppressed)`,
  the `strandedKeys` (pnpm.overrides NOT READ) check and the CI-unverified rule. Pre-fix those ran
  on an envelope. Repro: suppression-only fixture + `--advisory-file` with a patched version +
  `CI=true pnpm_config_registry=http://127.0.0.1:9/` → HEAD guard exit 1 FIX AVAILABLE, 926b691
  guard exit 0 "0 override(s) ... NONE verified". Starter `check.mjs` and lt-monorepo
  `check-audit.mjs` degrade every envelope (even 401) to non-blocking and their CI runs the guard
  LIVE, so CI goes green. nuxt's runner blocks on audit exit != 0 (unaffected); nest-server CI uses
  `--audit-file` (FAIL, unaffected).

**How to apply:** when the guard changes, re-run the stub matrix (scratch `sec-w2c/stubs.mjs`
pattern) AND the suppression-only fixture above; check that a failed audit still lets the
GitHub-side checks run. `--audit-file` "ok" remains for the all-zero shape and hand-made shapes
(`{"advisories":{}}`, `"error":null`) — none is pnpm-11-producible, by design.

Related: [[project-check-overrides-unusable-fix-residual]], [[project-pnpm-overrides-propagation]]
