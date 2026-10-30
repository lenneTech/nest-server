---
name: redis-boot-ping-and-resubscribe-costs
description: Measured costs of CoreRedisService's boot ping, the channel registry and re-subscribe on reconnect (ioredis 6); why an outage-time shutdown takes 2 s + 2 s
metadata:
  type: project
---

Measured 2026-10-29 (branch dev-3894, ioredis 6.0.0, local Redis on 6380, Node 24).

Boot ping (`checkReachableAtBoot`, awaited in `onModuleInit`):
- Redis up: onModuleInit 33-47 ms vs 23 ms on develop (both include the lazy `import('ioredis')`), so +10-25 ms for connect + ready check + PING.
- Redis refused / blackholed host: ~2.03 s (the default `commandTimeout: 2000` wins the race). Only with `commandTimeout` overridden away does the 3 s timer decide (3.03 s). The timer is unref'd and cleared.

ioredis behaviour that drives the shutdown cost:
- `commandTimeout` is armed in `sendCommand()` BEFORE the offline-queue branch, so queued commands do time out. BUT a timed-out command stays in `offlineQueue`.
- `quit()` disconnects at once only while `offlineQueue.length === 0`. With the leftover ping queued, quit waits for the 2 s race in `onApplicationShutdown()`, and after `disconnect()` a ref'd timer keeps the process up about 2 s more. Measured: shutdown 2.0 s plus exit 2.0 s later. On develop it was 0.4 ms and 3 ms with an idle client.
- The same cost occurs on develop as soon as ANY command was issued during the outage, which the measurement confirmed. So the boot ping only makes it deterministic for an idle replica. It is bounded and happens only during an outage, so it stays below a Critical/High bar.
- The queue is flushed after `maxRetriesPerRequest` (default 20) reconnect attempts: about 11 s with ECONNREFUSED, minutes for a blackholed host (`connectTimeout` 10 s per attempt).

Re-subscribe on reconnect:
- ioredis's `readyHandler` runs autoResubscribe synchronously. `setStatus('ready')` emits via `process.nextTick`, so a `ready` listener ALWAYS runs after it, which gives 2 SUBSCRIBE commands per reconnect (measured via `cmdstat_subscribe`). Each command is a single multi-channel command.
- At 50k channels the re-subscribe finished in about 0.6 s with roughly 180 ms of client CPU (including the probe's polling). Not a concern at realistic channel counts.
- `subscribedChannels` mirrors `CoreRedisPubSub.handlers` with one hold per channel. Releasing every channel empties it. The tenant guard holds one channel.

**Why:** These questions come back every time Redis readiness or shutdown changes. **How to apply:** Do not flag the boot ping or the double SUBSCRIBE as regressions. Re-measure only if `commandTimeout` defaults or ioredis's offline-queue semantics change. See [[auth-gate-per-request-cost]] for the measuring style.

Related take-along (scripts/check-mutations.mjs, `process.exitCode` instead of `exit()`): the normal path holds no handles, because every vitest child has closed. On a CRASH inside the parallel path, the other lanes keep pulling from the cursor until the registry is done. That is bounded by a normal run, so it is not a hang.
