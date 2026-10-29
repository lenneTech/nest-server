---
name: project-redis-channel-registry-resubscribe-facts
description: DEV-3894 (12.1.1) CoreRedisService.subscribeChannel/releaseChannel refcount + re-subscribe on 'ready' traced sound; ioredis 6 reconnect ordering facts; TCP-proxy probe recipe
metadata:
  type: project
---

DEV-3894 (branch feature/dev-3894-redis-readiness-tenant-resubscribe, reviewed 2026-10-29): tenant-cache
invalidation channel + CoreRedisPubSub channels go through `CoreRedisService.subscribeChannel()` /
`releaseChannel()` (per-channel holder count, re-subscribed on every `ready` of the shared subscriber).
Traced sound, zero findings above the bar.

Facts that settle the usual worries (re-verify if the code moves):
- Channel names cannot collide across features: guard `<prefix>:tenant-cache:invalidate`, PubSub
  `<prefix>:pubsub:<trigger>`. So no PubSub refcount error (failure-path release, destroy race, double
  release) can ever drop the tenant channel. Only guard instances hold/release it; Nest calls
  bootstrap AND destroy on providers + injectables alike, so multiple guard instances stay balanced.
- PubSub `onModuleDestroy` used to guard `unsubscribe(...channels)` with `if (channels.length)` because a
  zero-arg UNSUBSCRIBE drops ALL channels (incl. tenant). The new `Promise.all(channels.map(release))`
  keeps that safe. Re-check this if anyone reintroduces a bulk unsubscribe.
- ioredis 6.0.0: `setStatus()` emits via `process.nextTick`, so a 'ready' listener runs AFTER the
  readyHandler's autoResubscribe + offline-queue flush. A `commandTimeout`-rejected command stays queued
  and is still sent later (Command.setTimeout only rejects); `maxRetriesPerRequest` flushQueue is what
  really drops it. autoResubscribe only replays channels whose SUBSCRIBE once succeeded (prevCondition
  saved only on close from 'ready') — the original bug.
- Residual (pre-existing, documented, below bar): invalidations PUBLISHED during an outage are lost; the
  replica stays stale for those until `cacheTtlMs`. Not replayed, caches not flushed on reconnect.
- New log lines carry only ioredis error.message ("Command timed out", "Reached the max retries…") — no
  URL/password; the per-connection 'error' logger already logged the same class of messages.

Probe recipe (no repo files): scratch vitest config (`test.dir` = scratchpad, unplugin-swc with
legacyDecorator + decoratorMetadata), real Redis on 6380, a `net` TCP proxy on a free port opened LATE to
simulate "Redis comes back" and closed (destroy sockets) for a mid-life outage; publish from a second
CoreRedisService and assert a RecordingTenantGuard subclass receives. Run both default ioredis options and
`{ maxRetriesPerRequest: 1, retryStrategy: () => 50 }`. Related: [[project-hub-module-security-model]].
