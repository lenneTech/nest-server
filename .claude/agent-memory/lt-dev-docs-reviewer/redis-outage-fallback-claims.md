---
name: redis-outage-fallback-claims
description: "Every Redis consumer has a fallback" is false for configured-but-DOWN Redis — TUS Redis locker and CoreRedisPubSub fail; ioredis keeps a timed-out command queued; probe recipe
metadata:
  type: project
---

The in-memory fallbacks (in-memory PubSub, @tus/server's in-process locker) are chosen at boot by
`redisService.enabled` — i.e. by CONFIGURATION, not by connection state. So with `redis` configured
and the server down:

| Consumer | Outage behaviour |
|---|---|
| RateLimitStore (auth / better-auth / AI / api-token) | degrades to in-memory, logged |
| Cron leases, MCP session registry, tenant broadcast publish | fail open / debug |
| IAM user-cache broadcast (`CoreBetterAuthUserMapper`, 12.1.1, `<prefix>:iam-user-cache:invalidate`) | publish rejects after commandTimeout → WARN; other replicas fall back to the 15 s TTL. Channel via `subscribeChannel()`, so re-subscribed on `ready` |
| `TusRedisLocker.lock()` | rejects `Command timed out` after 2 s, every TUS request fails |
| `CoreRedisPubSub` | subscribe rejects; publish warns and DROPS the event — not even delivered on the same replica |

Seen 2026-10-29 (DEV-3894, 12.1.1): README "Redis outages" bullet, the Central Redis row, the
`checkReachableAtBoot()` JSDoc and its boot WARN all said "every consumer uses its fallback".

**Why:** the "fallback" wording comes from the 11.33.0 "absent = process-local fallback" story and
gets reused for the outage case, where it does not hold.

**How to apply:** on any Redis-outage doc claim, check TUS + PubSub first. Probe via `npx tsx` from
the scratchpad: `new CoreRedisService({ getFastButReadOnly: k => k==='redis' ? {host:'127.0.0.1',port:6599} : undefined, configFastButReadOnly: {} })`,
`await onModuleInit()`, then `new TusRedisLocker(svc).newLock('u').lock(signal, async()=>{})` and
`new CoreRedisPubSub(svc).subscribe/publish`. Boot ping reports `Command timed out` (commandTimeout
2000 < the 3 s ping bound).

ioredis nuance: a command rejected by `commandTimeout` STAYS in the offline queue and is still sent on
reconnect until `maxRetriesPerRequest` (default 20) flushes it — so "a failed SUBSCRIBE is lost for
good" is only true for longer outages. Historical prose, not a finding by itself. See
[[executable-doc-recipes]].

**Fixed in the same review (2026-10-29):** README, the Central Redis row, the JSDoc of `checkReachableAtBoot()` and the boot warning now name which consumers fall back (rate limits, cron leases, MCP session registry, tenant broadcast) and which have none (GraphQL subscriptions, TUS upload locks). Re-check new outage wording against this split.
