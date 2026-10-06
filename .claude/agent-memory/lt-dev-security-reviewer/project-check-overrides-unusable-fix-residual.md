---
name: project-check-overrides-unusable-fix-residual
description: Acceptance checklist for `auditConfig.unusableFixConsumers` in check-overrides — first attempt (2026-10-06) was REVERTED before landing because a backport fix or a second parent stayed green; re-run the demo when it returns
metadata:
  type: project
---

**Status:** NOT in the code. The first attempt was reverted by its author on 2026-10-06 after this review,
before landing; a second attempt is planned. Treat everything below as the acceptance checklist for it.

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
