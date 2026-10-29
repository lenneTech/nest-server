---
name: check-overrides-guard-test-facts
description: Testability facts for scripts/check-overrides.mjs after 12.1 added the registry lookup for advisories without a named fix — offline seams, CI pinning, mutation timing
metadata:
  type: project
---

Since 12.1 (commit d2e3285) an advisory with no `first_patched_version` is decided from the lockfile
plus the REGISTRY (`registryFix()`), not skipped. Facts that make reviewing its tests cheap:

- Spec `buildWorkspace()` passes `--advisory-file` AND `--packument-file` whenever `advisoryData !== null`,
  so no case reaches api.github.com or the registry. Live path only via `CHECK_OVERRIDES_ADVISORY_API`
  (loopback-only); the registry root is DERIVED from it (`NPM_REGISTRY_ROOT`), so one stub serves both.
- Old fixtures `{ first_patched_version: null }` without `vulnerabilities` now read UNVERIFIED, which
  FAILS under `CI` — every such fixture was migrated to `unnamedFix()` + `FORGE_NO_FIX`. When reviewing a
  later change, grep for a bare `first_patched_version: null` expecting status 0 without `CI: ''`.
- Packument ages are relative to `Date.now()` (`forgePackument`), so the release-age cases do not rot.
- Verified 2026-10-29: both specs green with and without `CI=true`; all six `suppression-unnamed-fix-*`
  mutations red (~1 min each, sequential `--id`).

Legacy REST rate limit (440f29e) keys on `context.getHandler().name`; REST `signIn` and GraphQL `signIn`
now share one bucket per IP (stricter than before). The unit spec's second case is the paired control
that kills ip-only / constant / handler-only keys.

Related: [[cross-repo-probe-gotchas]], [[scratch-copy-mutation-check]].
