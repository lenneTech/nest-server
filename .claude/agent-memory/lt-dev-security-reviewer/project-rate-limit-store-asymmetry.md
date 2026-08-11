---
name: project-rate-limit-store-asymmetry
description: The Redis rate-limit store has NO key cap while the in-memory one carefully has one — and both key on an unconditionally trusted X-Forwarded-For, so a spoofed header both bypasses the limit and writes unbounded keys into the shared Redis every other subsystem now depends on.
metadata:
  type: project
---

# `RateLimitStore` — the cap exists in one implementation only

Verified 2026-08-10 against `src/core/common/services/rate-limit-store.ts`,
`auth/guards/legacy-auth-rate-limit.guard.ts`, `better-auth/core-better-auth-rate-limit.middleware.ts`.

## The asymmetry

`InMemoryRateLimitStore` is deliberately hardened: `maxEntries = 10000`, eviction of expired entries,
and — the good part — a fixed set of 64 **overflow buckets** so that a saturated store still COUNTS
unknown keys instead of handing every fresh key an uncounted `1`. Its own comment names the reason:
"both key parts are caller-influenced (a spoofable `X-Forwarded-For` and the request path), so
filling it is cheap."

`RedisRateLimitStore` has **none** of that. `hit()` is `INCR` + `EXPIRE` on
`<keyPrefix>:rate-limit:<namespace>:<key>` with no cap and no accounting. So the moment `redis` is
configured, the defense the in-memory store was given is gone — and the keys now land in the SHARED
Redis that also holds cron leases, MCP session ownership, tenant-cache invalidation and Hub buffers.

## The key is forgeable

`getClientIp()` in BOTH limiters reads `x-forwarded-for` (then `x-real-ip`) unconditionally — no
`trust proxy` gate, no hop counting. A client that varies the header per request gets a fresh
counter per request. This predates 11.33.0; what 11.33.0 changed is where the resulting keys go.

## Degradation behaviour (correct, but note the reset)

`guard()` catches any Redis error, logs once per transition, and falls back to a per-replica
`InMemoryRateLimitStore` — never a 500, never "allowed". `commandTimeout: 2000` on the ioredis
connection is what makes that reachable instead of hanging in the offline queue. The fallback store
starts EMPTY, so a Redis outage does hand every client one fresh window.

## How to apply

- Any finding about "rate limiting is now distributed" must check the cap question separately from
  the correctness question — the Lua script is fine, the key space is not.
- `escapeGlob()` escapes `? [ ] * \ ^` but NOT `:`, the framework's own key separator — so
  caller-controlled parts can straddle a segment boundary (`ip="1.2.3.4:5", ep="/a"` collides with
  `ip="1.2.3.4", ep="5:/a"`).
- The same forgeable-key + unbounded-keys shape applies to
  `CoreBetterAuthEmailVerificationService.cooldownKey(email)` (one Redis key per attempted address).

Related: [[project-hub-config-masking-gaps]]
