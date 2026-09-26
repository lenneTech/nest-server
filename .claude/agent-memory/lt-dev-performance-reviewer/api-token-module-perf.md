---
name: api-token-module-perf
description: Per-request cost profile of src/core/modules/api-token (added 11.41.4) — what every request pays with the feature off/on, what a token request pays, and which bounded structures were already verified.
metadata:
  type: project
---

Derived 2026-09-26 from a static review of the uncommitted api-token module on `develop` (zero findings).
Reuse this instead of re-deriving the chain on the next change to the module.

## Every request (token or not)

- `CoreApiTokenMiddleware` is registered only when `apiTokens` is configured (`CoreModule` imports
  `CoreApiTokenModule` conditionally). With the feature off it does not exist.
- `hasApiTokenCredential()` / `enforceApiTokenRoute()` run from `CoreBetterAuthMiddleware` and all three
  guards regardless. `getApiTokenConfig()` re-resolves `configFastButReadOnly` on each call (the frozen
  object, no clone). Measured with a replica of the helpers: ~3 ns with the feature off, ~12 ns on a cookie
  request, ~400 ns on a 300-char JWT Bearer header (the `/^bearer\s+(\S+)\s*$/i` exec). Up to ~4 calls per
  request, so roughly 1.6 µs at worst. Do NOT flag it.
- Guards read `getApiTokenContext(request.user)` (a symbol property) before anything else. On the
  `request.user`-set path that is the whole cost.

## A token request

- `findOne({ publicId })` (`unique: true` → indexed) with `.lean()`, plus one `users.findOne({ _id })` for a
  USER token. Neither is cached. That matches the session path (its aggregation is uncached too, see
  [[auth-gate-per-request-cost]]).
- Assertions add a sha256 + AES-GCM decrypt of 64 bytes + HMAC. That is microseconds.
- A failed prefixed credential gets a 401 from the middleware. There is no second verification in the
  guard, unlike the Better-Auth failure path.
- The token model uses `tenant`, not `tenantId`, so `mongooseTenantPlugin` (which checks
  `schema.path('tenantId')`) never filters the lookup.
- TENANT tokens skip the membership lookup in `CoreTenantGuard` entirely. A USER token with
  `maxTenantRole` bypasses `tenantIdsCache` in `resolveUserTenantIds`, which costs one membership `find`
  per request for capped tokens only. That is by design.

## Bounded structures (verified)

- `lastUsedWrites` Map: capped at 5000 and CLEARED when full. It is only filled after successful
  authentication, so garbage credentials cannot inflate it. Caveat: with more than 5000 distinct active
  tokens per process per minute, the throttle degrades toward one write per request. The memory stays
  bounded. That is the only scale knob worth re-checking.
- Rate limit: `InMemoryRateLimitStore(10_000)` (fold-in at capacity) or Redis. It is keyed by tokenId
  after authentication. Its constructor starts an `unref`'d interval that `CoreApiTokenService` never
  clears. That is harmless in prod and a small leak per app instance in tests.
- Management `list()` is unpaginated, and no per-user cap exists on token count. It is a management path,
  not hot.

Related: [[redaction-regex-costs]]
