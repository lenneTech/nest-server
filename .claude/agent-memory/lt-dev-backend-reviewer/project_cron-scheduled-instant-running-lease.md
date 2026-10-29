---
name: cron-scheduled-instant-running-lease
description: DEV-3896 (12.1.1) CoreCronJobs tick lease keyed on the scheduled instant + runParallel:false running lease; cron 4.4 timer facts verified, no High found (2026-10-29)
metadata:
  type: project
---

DEV-3896 review (2026-10-29, commits 49b3e08 + 3267892): zero Critical/High.

Verified facts about cron 4.4.0 (do not re-derive):
- `lastExecution` (= `lastDate()`) is set at construction when `runOnInit` is true, and on a scheduled fire right BEFORE `start()` re-arms and `fireOnTick()` runs. `fireOnTick()` (Hub "Run now") never touches it.
- `callbackWrapper` re-arms when the timeout fired early and compensates wall-clock steps (diff check against `Date.now()`), so a scheduled fire always has `lastDate() >= armed instant`. `fired < scheduledFor` therefore only matches manual runs.
- `getNextDateFrom()` drops milliseconds and is monotonic across Europe/Berlin DST (fall-back repeated hour and spring gap probed); stepping from the remembered instant gives the same result as cron's own `sendAt()` from the fire time.
- `sendAt()` throws for a past one-shot Date, so `start()` throws for it too; the negative-timeout branch in `start()` is unreachable for patterns.
- A fire >1 period late is keyed on the last instant <= fire; it never yields two keys for one fire, so no duplicate across replicas.

Running lease (`<job>:running`, 60 s, heartbeat 20 s) verified: owner-checked Lua renew/release (Redis), Mongo/Postgres/MySQL LockStore semantics, runTick finally order, BullMQ `opts` template (`JobSchedulerTemplateOptions` since 5.16; attempts:1 equals BullMQ's default; nothing in src reads completed/failed cron jobs).

Dropped as below the bar: `CronJob.setTime()` to a FASTER schedule leaves `scheduledFor` ahead, so ticks count as manual (no dedup) until the old instant passes — nothing in src/starter calls setTime. Per-second job stopped >10,000 periods keys one stale instant.

Probe recipe: `.mts` file in scratchpad importing the TS source by absolute path, run with `node_modules/.bin/tsx` (a `.ts` file fails on top-level await under cjs).

Related: [[cron-bullmq-restore]], [[review-tree-is-shared-and-mutable]]
