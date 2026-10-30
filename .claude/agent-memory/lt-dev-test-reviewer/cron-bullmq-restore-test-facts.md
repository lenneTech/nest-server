---
name: cron-bullmq-restore-test-facts
description: DEV-3889 review (2026-10-29) of the BullMQ scheduler restore tests — which mutation fails which test and why, why the e2e "2 red" is one test in two vitest projects, timing headroom, and the restore-vs-reconciliation interaction judged below the bar
metadata:
  type: project
---

All four registered mutations of DEV-3889 were run in scratch clones and fail for the right reason:
`cron-reconnect-does-not-restore` and `cron-scheduler-check-timer-missing` time out in `waitUntil` (2 s)
in `tests/unit/core-cron-jobs-dedup.spec.ts`, `cron-restore-upserts-existing-schedulers` fails the refusal
with "called 2 times" (the mutated upsert is SYNCHRONOUS, so the two `setImmediate` flushes are ample), and
`cron-e2e-scheduler-check-missing` fails `restored?.pattern` after the 5 s deadline.

**"2 test(s) went red" for one e2e test is not collateral damage**: `tests/multi-replica.e2e-spec.ts` is not
in `POSTGRES_E2E_EXCLUDED`, so the `e2e` AND `postgres` projects both run it (separate pids → separate
`RUN_PREFIX`, no key collision). Verify with a direct run (`|e2e|` / `|postgres|` in the FAIL lines).

Timing headroom measured: e2e restore ~320 ms against a 5 s deadline (3 runs, `--retry=0`); unit file 16/16
green with 8 concurrent runs. The e2e has a theoretical race (a 200 ms tick whose read reaches Redis right
after the DEL and whose upsert is written before the test's own `getJobScheduler`) — window of tens of µs,
retry:2 absorbs it; not reportable.

Not a test gap (judged Medium, dropped under the bar): an OLD replica's periodic restore can re-add a
scheduler a NEWER replica's `removeStaleBullSchedulers()` just removed during a rolling deploy. Disabled /
removed jobs are dropped by the worker ("no registered config"); only a `distributed: false` switch gets one
extra run per tick until the next new-replica boot. The Hub's cron stop/start acts on the stopped registry
CronJob only, never on the BullMQ scheduler, so restore cannot resurrect an operator-stopped job.

Two clones in the scratchpad (one for unit, one for the e2e mutation) can run the gate concurrently.
Related: [[scratch-copy-mutation-check]], [[cross-repo-probe-gotchas]].

**Changed in the same review (2026-10-29):** the restore no longer asks `getJobScheduler()` per job; it reads the queue's listing (`getJobSchedulers()`, one call per check) because `getJobScheduler()` is missing before bullmq 5.23 and wrong up to 5.40.2. A scheduler `removeStaleBullSchedulers()` removed carries a `cron-scheduler-removed:<job>` key that the restore honours, so the rolling-deploy resurrection is closed (mutation `cron-restore-ignores-removal-marker`); registerBullJob() deletes the key.
