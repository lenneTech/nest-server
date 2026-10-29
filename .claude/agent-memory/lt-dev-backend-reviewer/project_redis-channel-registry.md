---
name: project_redis-channel-registry
description: DEV-3894 (12.1.1) CoreRedisService boot ping / isReady / subscribeChannel+releaseChannel refcount, re-subscribe on subscriber 'ready' — probed sound against real ioredis 6.0.0; check-mutations exitCode switch
metadata:
  type: project
---

DEV-3894 reviewed 2026-10-29 (branch feature/dev-3894-redis-readiness-tenant-resubscribe): zero findings above
the bar. Probed against the real Redis container (6380) through a late-opened TCP proxy.

Measured / verified (re-check if the code moves):
- Boot ping with Redis down: ~2.0 s with default `commandTimeout: 2000`, 3.0 s when a project sets
  `commandTimeout: undefined`. No unhandled rejection.
- Tenant channel arrives after a ~13 s boot outage with DEFAULT ioredis options (maxRetriesPerRequest 20
  flushes the queued SUBSCRIBE at ~10.5 s, so the 'ready' re-subscribe is what saves it) and after a
  mid-life outage.
- Multi-channel `subscribe(...channels)` on 'ready' works on RESP3 (ioredis 6 default `protocol: 3`) and
  RESP2; a channel released during the outage stays unsubscribed.
- Two PUB_SUB engines (CoreAuthModule + UserModule) on one CoreRedisService share trigger channels; the
  refcount fixes the old "first leaver UNSUBSCRIBEs for both".
- PubSub subscribe failure now takes ~4 s (SUBSCRIBE timeout + release UNSUBSCRIBE timeout) — latency only.
- `isReady()` is the SHARED client only; the subscriber can still be in backoff ~2 s longer. A probe that
  waits on `isReady()` and then subscribes can time out — wait for `subscriberClient.status` instead.
  (Cost me one false alarm.)
- check-mutations `process.exitCode`: normal end leaves nothing ref'd (children closed, worktrees removed in
  `.then`). Crash in PARALLEL mode now lets the other lanes finish the registry before exit 1 (was instant
  exit) — time cost only, exit code unchanged.

Probe recipe: scratchpad dir with `node_modules` SYMLINKED to the repo's, vitest config with bare imports
(`unplugin-swc`, `vitest/config`), `root` = repo, `test.dir` = scratchpad. Absolute-file-URL imports of the
plugin break Vite's config bundling. Related: [[review-tree-is-shared-and-mutable]].
