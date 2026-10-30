---
name: project-cron-bullmq-scheduler-restore-facts
description: DEV-3889 BullMQ scheduler restore and DEV-3896 cross-replica running lease traced sound; why no schedule can run a disabled job; lease key/Lua/Hub-name facts
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

**DEV-3896 (2026-10-29, zero security findings):** running lease for `runParallel: false` distributed jobs, key
`<name>:running` (Redis `<keyPrefix>:cron-lock:<name>:running`, SQL `cron:<name>:running` in the lease table, Mongo
`cron-locks` `_id`). Lua renew/release are constants with KEYS/ARGV (owner-check proven against real Redis in
`tests/multi-replica.e2e-spec.ts`); SQL/Mongo release+renew are owner-filtered and parameterized. Job names come only
from project code; the Hub action `POST actions/cron/:name/:action` resolves the name through `SchedulerRegistry.getCronJob`
(must exist) behind hub roles + `X-Hub-Request` + typed confirm. No attacker-controlled first segment after keyPrefix exists
anywhere (`rate-limit:`, `email-verification-cooldown:`, `ai-mcp-session:` all fixed segments), so no cross-feature key
collision. Pre-existing, below bar: a Hub "trigger" runs the job inside the HTTP RequestContext (admin user/tenant), and
in BullMQ mode a manual trigger takes the `:init` lease. Design trade-off: a HUNG exclusive job now blocks the job fleet-wide
(heartbeat keeps the lease) — before, only its own replica.

**Changed in the same review (2026-10-29):** the restore no longer asks `getJobScheduler()` per job; it reads the queue's listing (`getJobSchedulers()`, one call per check) because `getJobScheduler()` is missing before bullmq 5.23 and wrong up to 5.40.2. A scheduler `removeStaleBullSchedulers()` removed carries a `cron-scheduler-removed:<job>` key that the restore honours, so the rolling-deploy resurrection is closed (mutation `cron-restore-ignores-removal-marker`); registerBullJob() deletes the key.
