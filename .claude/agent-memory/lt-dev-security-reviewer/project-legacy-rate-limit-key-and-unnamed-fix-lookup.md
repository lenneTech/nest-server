---
name: project-legacy-rate-limit-key-and-unnamed-fix-lookup
description: 12.1.0 legacy REST rate-limit keyed on handler name (REST+GraphQL now share a bucket); check-overrides registryFix() unnamed-fix lookup traced fail-loud
metadata:
  type: project
---

Reviewed 2026-10-29 (commits 440f29e, d2e3285), zero findings.

**LegacyAuthRateLimitGuard (REST):** key is `context.getHandler()?.name`, no longer the last URL segment
(query string / case / trailing slash each minted a fresh bucket). Handler names (`signIn`, `signUp`,
`logout`, `refreshToken`) equal the GraphQL field names, so REST and GraphQL now share ONE bucket per IP
per operation — stricter (attacker used to get 2x max by alternating transports). Any wrapper/empty name
collapses into a shared bucket ('unknown'), never a per-request one.

Pre-existing, outside that diff: guard metadata lives on the function, so an override without a
re-declared `@UseGuards(LegacyAuthRateLimitGuard)` runs no rate limit at all —
`src/server/modules/auth/auth.resolver.ts` signIn/signUp are such overrides (src/server config sets no
`auth.rateLimit`; starter has no auth module). Re-check if a starter/project copies that resolver.

**check-overrides.mjs registryFix():** every unreadable input (range with `||` or no comma, 4-part
version, peer-suffixed version, unreachable registry, offline run without --packument-file) lands in
UNVERIFIED, which fails under CI. Pre-release locked copy reads as its release -> may yield NOT IN TREE
(loud FAIL), not a silent pass. Known benign residuals: one copy without a way out keeps the whole
suppression (`'none'`), `resolvedVersions()` also matches `@scope/<name>@v` for unscoped `<name>`
(phantom copy; can only flip to 'none' with multi-interval ranges), and a registry without `time`
keeps a fix "pending" forever (printed on the green path). Packument fetch sends no credentials.

**Why:** both are release-gating paths; re-verify these facts before re-reporting either area.
**How to apply:** when the guard key or the suppression check changes again, start from these traces.
