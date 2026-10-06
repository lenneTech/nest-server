---
name: project-check-overrides-unusable-fix-residual
description: `auditConfig.unusableFixConsumers` in check-overrides (landed 11.42.5 after two review rounds) — the expiry checks and the repro cases that must keep failing; re-run them when the guard changes
metadata:
  type: project
---

**Status:** landed in nest-server 11.42.5 (2026-10-06) after two review rounds. Round 1 (first attempt,
reverted): backport and second parent stayed green. Round 2 found `dependentsOf()` reading only
`snapshots:` (a direct dependency in `importers:` stayed green) and parents compared by name only
(a second consumer version rode along). Both fixed; repro cases A–J in the review scratchpad all
fail/pass as expected (A,B,C,D,D2,H,I,J → exit 1; E,F,G → 0), six `unusable-fix-*` mutations registered.
Below: the first attempt's description, kept as the checklist for any future change to this guard.

The reverted attempt gave `scripts/check-overrides.mjs` an `auditConfig.unusableFixConsumers: { GHSA: '<consumer>@<version>' }`
(2026-10-06, written by the lt-crm session for three `simple-git` advisories reachable only via
`nuxt > @nuxt/devtools`). A declared suppression over a FIXED advisory passes as a "residual" as long
as `resolvedVersion(consumer)` (first lockfile match) equals the recorded version.

**Blind spots found in review (reported as High, gate defect):**
- `advisoryStatus()` collapses `vulnerabilities[].first_patched_version` to the first non-null value;
  the declared branch only checks that one exists. An upstream in-major BACKPORT the consumer can use
  never re-opens the check — the exact GHSA-mh99-v99m-4gvg precedent the package-management rule cites.
  The green-path line then claims "fix X exists but <consumer> cannot use it", which is false.
- Only the declared consumer is watched. A second parent pulling the same vulnerable package (prod
  path included) is covered by the global `ignoreGhsas` and the guard stays exit 0.

**How to apply:** when this file changes again, re-run the scratch demo (temp dir with the script,
`ignoreGhsas` + declaration, lockfile with devtools@3.4.1 AND a second parent, advisory-file with an
in-major `first_patched_version`) and check for exit 0. If it now fails with RE-TEST, the gap is closed.

Related: [[project-pnpm-overrides-propagation]]
