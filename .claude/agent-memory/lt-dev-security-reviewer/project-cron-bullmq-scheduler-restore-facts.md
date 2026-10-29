---
name: project-cron-bullmq-scheduler-restore-facts
description: DEV-3889 (12.1.1) BullMQ cron scheduler restore traced sound; why a resurrected or foreign schedule cannot run a disabled job; rolling-deploy resurrection residual below bar
metadata:
  type: project
---

DEV-3889 added `restoreBullSchedulers()` to `CoreCronJobs` (runs on the queue connection's `ready` and every
`bullSchedulerCheckIntervalMs`, 60 s). Reviewed 2026-10-29, zero findings.

Load-bearing facts (re-verify before relying on them):
- The restore set is `bullScheduledJobs`, filled only in the `initCronJobs()` loop AFTER the disabled/falsy/missing-function
  checks, so it is always a subset of this process's own ACTIVE config. It upserts only when `getJobScheduler(name)` is
  falsy; it never touches other names, so a foreign app on the same `keyPrefix` keeps its schedulers.
- `runTick()` returns (warn "no registered config") when `jobConfigs[name]` is missing. A disabled job never gets a
  `jobConfigs` entry, so NO schedule in the shared queue (resurrected, foreign app, stale) can make a replica run a job
  its own config disabled. That is the guard to check if anyone asks "can a schedule run a disabled job".
- Hub `controlCron('stop')` on a BullMQ job only stops the STOPPED registry CronJob; nothing in the framework removes a
  BullMQ scheduler except `removeStaleBullSchedulers()` at boot. So the restore does not override an operator action.

Residual (below the bar, not reported): during a rolling deploy an OLD replica's timer can re-add a scheduler the new
version's boot removed (job disabled or switched to `distributed: false`), if it fires between the last new boot and the
old replica's shutdown (readiness delay + `shutdownDelayMs`). Effect: warn per tick until the next deploy, or one extra run
per tick for a `distributed: false` job. Only becomes reportable if a job's semantics make that extra run harmful.

**How to apply:** for later cron/BullMQ diffs, start from the runTick guard and the subset property above; related
[[project-rate-limit-store-asymmetry]] for the other keyPrefix-sharing surfaces.

**Changed in the same review (2026-10-29):** the restore no longer asks `getJobScheduler()` per job; it reads the queue's listing (`getJobSchedulers()`, one call per check) because `getJobScheduler()` is missing before bullmq 5.23 and wrong up to 5.40.2. A scheduler `removeStaleBullSchedulers()` removed carries a `cron-scheduler-removed:<job>` key that the restore honours, so the rolling-deploy resurrection is closed (mutation `cron-restore-ignores-removal-marker`); registerBullJob() deletes the key.
