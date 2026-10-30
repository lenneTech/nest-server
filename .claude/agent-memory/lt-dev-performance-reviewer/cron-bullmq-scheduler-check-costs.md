---
name: cron-bullmq-scheduler-check-costs
description: Measured cost of CoreCronJobs' BullMQ scheduler check (restoreBullSchedulers, 12.1.1/DEV-3889) healthy and during a Redis outage; bounds of the in-flight guard and the shutdown wait
metadata:
  type: project
---

Measured 2026-10-29 against the test Redis (6380), bullmq 6.5.0, ioredis 6.0.0, same queue options as
`initBullMq()` (`commandTimeout: 10_000`, `maxRetriesPerRequest: 3`), probe = copy of the check loop:

- Healthy: one `getJobScheduler()` = one EVALSHA (ZSCORE + HGETALL), ~33 us Redis CPU. A 50-job check took
  10.6 ms client-side (sequential local round trips) = ~1.6 ms Redis CPU per replica per 60 s. N x M load is
  negligible; do not flag it.
- Outage (connection refused): each command settles in 0.5-10 s (MaxRetriesPerRequest flush every 4 reconnect
  attempts, else the 10 s commandTimeout, which ioredis arms BEFORE offline-queueing). Nothing hangs forever;
  the in-flight guard coalesces timer ticks + `ready`, so no pile-up. Warn volume <= 1 line per command, well
  below CoreRedisService's own per-reconnect "Redis connection error" lines.
- Shutdown during an outage: `stopBullSchedulerCheck()` clears the live Set, so the awaited check ends after the
  ONE in-flight command — measured 9.7 s, i.e. bounded by commandTimeout. Nest shuts down the root module
  (where a project's CronJobs lives) before CoreModule, so CoreRedisService has not disconnected yet.

Known, below the Critical/High bar (not reported in the 2026-10-29 review), re-check if it changes:
- `bullSchedulerCheckIntervalMs` guard is `> 0`; `Infinity` / > 2^31-1 would make Node clamp setInterval to 1 ms
  (back-to-back checks). Only reachable by a subclass setting the protected field.
- Rolling deploy: an OLD replica's timer re-upserts a scheduler that a NEW replica's boot reconciliation
  (`removeStaleBullSchedulers`) just removed (job disabled / switched to `distributed: false`); it then persists
  until the next deploy's boot. Correctness, not perf; harm is one warn (disabled) or one extra run (non-distributed)
  per tick.

**Why:** reviewers re-derive these bounds from BullMQ/ioredis internals every time; the numbers settle it.
**How to apply:** when the cron BullMQ path changes, re-run the probe only if the queue connection options, the
check loop shape (sequential vs Promise.all) or the shutdown order changed.

**Changed in the same review (2026-10-29):** the restore no longer asks `getJobScheduler()` per job; it reads the queue's listing (`getJobSchedulers()`, one call per check) because `getJobScheduler()` is missing before bullmq 5.23 and wrong up to 5.40.2. A scheduler `removeStaleBullSchedulers()` removed carries a `cron-scheduler-removed:<job>` key that the restore honours, so the rolling-deploy resurrection is closed (mutation `cron-restore-ignores-removal-marker`); registerBullJob() deletes the key.

**DEV-3896 review (2026-10-29), measured:**
- BullMQ `removeOnComplete: { count: N }` trims the WHOLE completed set in ONE Lua script (`removeJobsByMaxCount`: ZREVRANGE N..-1, no limit; only the `age` path is capped by `limit`, default 1000). Up to 12.1.0 the cron scheduler template had no opts, so every tick since 11.33.0 (2026-08-11) stayed in Redis. First completion after the upgrade: ~6.5 us/job of Redis block — 120k = 0.64 s, 300k = 1.96 s, 700k = 4.35 s (test Redis 6380, real upgrade path: old scheduler re-upserted with opts, next job carries them). Shared CoreRedisService client has `commandTimeout: 2000`; Redis `busy-reply-threshold` 5000. Bounded alternatives: `{ age, limit }` keepJobs, or `queue.clean(0, 1000, 'completed')` in a loop (cleanJobsInSet honours limit, oldest first). Reported as High; fixed in the same branch: `trimBullJobBacklog()` cleans the backlog in batches of 1000 before the first upsert (mutation `cron-bull-backlog-trimmed-at-once`), so the `count` trim only ever meets a short set.
- `currentScheduledInstant()` (cron 4.4.0, luxon 3.7.2): regular tick = 1 `getNextDateFrom` = 87 us (per-second) .. 327 us (hourly, minute-by-minute loop); `nextDate()` ~82-124 us. No extra steps across Europe/Berlin DST (simulated with luxon `Settings.now`). Full 10,000-step bound = 0.77 s (per-second) .. 3.3 s (hourly) event-loop block, only after a long Hub stop / paused process — one-time, not reported.
- Running lease (`runParallel: false` + distributed): +2 round trips per run (acquire, release) + one renew per 20 s; heartbeat cleared in `finally`, unref'd. Not a finding.
- `ensureLeaseIndex()` retry: one createIndex per tick while it keeps failing; the spec `{expiresAt:1},{expireAfterSeconds:0}` never changed, so only a missing privilege makes it persistent. Not a finding.
