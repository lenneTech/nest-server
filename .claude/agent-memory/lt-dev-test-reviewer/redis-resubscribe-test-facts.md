---
name: redis-resubscribe-test-facts
description: DEV-3894 review (2026-10-29) — why the TCP-proxy e2e for "subscribe failed at boot" cannot pass through ioredis's offline queue, its measured timing, and the source-level exit spec that accepts a commented-out exitCode line
metadata:
  type: project
---

**ioredis 6.0.0 facts that decide whether a "Redis down at boot" test is vacuous:**
- `closeHandler` flushes the OFFLINE queue (MaxRetriesPerRequestError) when
  `retryAttempts % (maxRetriesPerRequest + 1) === 0`. With `maxRetriesPerRequest: 1` and `retryStrategy: () => 50`
  that is the 2nd failed connect (~50 ms), far before `commandTimeout` (2000 ms). A rejection by `commandTimeout`
  alone would leave the command QUEUED and it would reach Redis on reconnect — that is the vacuity trap.
- `autoResubscribe` restores only `prevCondition.subscriber`, captured on close only when `prevStatus === 'ready'`
  and filled only by a SUBSCRIBE *reply*. A connection that never reached ready restores nothing.
- `readyHandler` emits `ready` (setStatus) BEFORE it re-subscribes / flushes the offline queue.

**Measured:** `tests/redis-consumers.e2e-spec.ts` "reaches a replica whose subscribe failed at boot" takes ~475 ms
(300 ms of it a fixed wait that is not load-bearing). 12 runs x 2 projects in waves of 4, `--retry=0`, load 5-8:
24/24 green. Mutations `redis-subscriber-ready-not-resubscribing` and `tenant-guard-subscribe-unregistered` fail at
the DELIVERY assertion (line ~277, after the 10 s publish loop) in both `e2e` and `postgres` projects — warn and
isReady assertions still pass, so it fails at the right step. Gate run ~34 s each (fast test, cheap retries).

`redis-ready-resubscribe-missing` turns 3 unit tests red via `TypeError: subscriber.handlers.get(...) is not a function`
(FakeRedis keeps one handler per event in a Map) — the missing listener is the cause, acceptable.

**`tests/unit/check-mutations-exit.spec.ts` is a source pin**: `toContain('process.exitCode = failed.length ? 1 : 0;')`
stays GREEN with that line commented out (then a failed gate exits 0) — the blind spot in
[[check-gate-coverage-blind-spots]] #3. Below the bar (adversarial edit), but name it when asked "is it meaningful".
Mechanism verified on macOS / Node 24: 1 MB to a slow pipe, `process.exit` delivers 65 400 bytes, `exitCode` all.

**Gate parallel path needs >= 4 mutations for `--jobs=2`** (`planJobs`: `mutationCount < requested*2` → floor(n/2)).
To exercise it in a scratch clone, commit a reduced registry with duplicated ids. The sequential path never prints the
`── <id> ──` header (only `log[0]`, emitted in parallel mode) — cosmetic, pre-existing.

Related: [[scratch-copy-mutation-check]], [[cron-bullmq-restore-test-facts]].
