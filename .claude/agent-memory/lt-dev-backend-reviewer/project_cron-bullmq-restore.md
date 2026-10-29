---
name: cron-bullmq-restore
description: DEV-3889 (12.1.1) restoreBullSchedulers in CoreCronJobs — verified BullMQ 6.5 semantics; High: an old replica resurrects a scheduler the new version's removeStaleBullSchedulers removed (rolling deploy)
metadata:
  type: project
---

DEV-3889 review (2026-10-29): `CoreCronJobs.restoreBullSchedulers()` re-registers BullMQ schedulers missing in Redis, on every `ready` of the queue connection and every `bullSchedulerCheckIntervalMs` (60 s).

Verified sound (do not re-derive): BullMQ 6.5 `getJobScheduler` returns `undefined` for a missing scheduler (Lua `{nil,nil}` and the zset-without-hash case both); `Queue.upsertJobScheduler` always passes `override: true` and `addJobScheduler-11.lua` removes the last planned job from delayed/prioritized/wait — so the existence check before the upsert is necessary. BullMQ wraps (does not duplicate) a passed ioredis instance, so `ready` on the queue client fires on a real reconnect (probed with `CLIENT KILL`). Shutdown order stop → await check → drain → close is correct; clearing the Set ends the running for-of.

**High reported:** during a rolling deploy, an OLD replica's periodic check re-registers a scheduler that a NEW replica's bootstrap `removeStaleBullSchedulers()` just removed (job switched to `distributed: false` / `utcOffset` / Date / `disabled`). Persists until the next new-version boot; for the local-timer cases the job then runs once more per tick via BullMQ (no lease). Reproduced against the test Redis with a tsx probe (two replica instances, different job configs, one keyPrefix). Suggested fix: tombstone key written by removeStale, honoured by restore, cleared by bootstrap registration.

**How to apply:** when this area changes again, check whether the tombstone (or equivalent) exists before re-flagging; the statelessness-invariants entry for `bullScheduledJobs` claims every replica derives the same set, which is false across versions/configs.

Related: [[review-tree-is-shared-and-mutable]]

**Changed in the same review (2026-10-29):** the restore no longer asks `getJobScheduler()` per job; it reads the queue's listing (`getJobSchedulers()`, one call per check) because `getJobScheduler()` is missing before bullmq 5.23 and wrong up to 5.40.2. A scheduler `removeStaleBullSchedulers()` removed carries a `cron-scheduler-removed:<job>` key that the restore honours, so the rolling-deploy resurrection is closed (mutation `cron-restore-ignores-removal-marker`); registerBullJob() deletes the key.
