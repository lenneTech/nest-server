---
name: iam-user-cache-broadcast-test-facts
description: DEV-3895 review (2026-10-29) — why the WS re-check unit test genuinely pins clear-before-recheck ORDER, that the mapper's Redis wiring was probed green in the assembled CoreModule, and the measured mutation verdicts
metadata:
  type: project
---

**Order is observable synchronously.** `revalidateWsConnectionsOf()` → `markStale()` → `ensureWsConnectionCurrent()` →
`revalidate()` is an async function, and an async body runs synchronously up to its first `await` — so
`connection.reauthenticate()` is CALLED inside `revalidateWsConnectionsOf()`. A test whose `reauthenticate` records
state at call time (`cacheSeenByReauthentication`) therefore proves ORDER, not just "a re-check happened". Measured:
swapping `userCache.delete` and `revalidateWsConnectionsOf` in `applyInvalidation()` turns
`tests/unit/better-auth-user-cache-invalidation.spec.ts` red with `expected [ true ] to deeply equal [ false ]`.
(Production `authenticateIamWsToken()` awaits a session/JWT check before `mapSessionUser()`, so it is less
order-sensitive than the test — the test is the stricter side.)

**Wiring probe (DI, not the hand-built mappers):** booting `CoreModule.forRoot(e2e envConfig + redis)` and
`moduleFixture.get(CoreBetterAuthUserMapper, { strict: false })` showed `redisService.enabled === true`, a live
`invalidationListener`, and a foreign `publish` on `<keyPrefix>:iam-user-cache:invalidate` cleared a seeded entry.
`CoreRedisService` comes from the `@Global()` CoreModule exports. No shipped test asserts this wiring (the multi-replica
e2e constructs mappers with `new`), but it works — not a finding.

**Mutations measured:** `iam-user-cache-e2e-not-broadcast` → red in both `e2e` and `postgres` projects at
`expected [ 'admin' ] to deeply equal []` after the 5 s poll; `iam-user-cache-remote-ws-not-revalidated` → red at
`expected [] to deeply equal [ false ]`. The new e2e case: 8/8 green sequential runs, ~2 s per run, pub/sub uses the
per-run `RUN_PREFIX`, so no cross-run channel collision and no keys to sweep.

AC "without redis unchanged": the real no-redis shape is a DEFINED `CoreRedisService` with `enabled: false` (always
provided), which the unit spec covers (no subscribe, no publish).

Related: [[redis-resubscribe-test-facts]], [[scratch-copy-mutation-check]].
