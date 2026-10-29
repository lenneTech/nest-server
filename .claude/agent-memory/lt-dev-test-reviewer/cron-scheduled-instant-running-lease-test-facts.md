---
name: cron-scheduled-instant-running-lease-test-facts
description: DEV-3896 review (2026-10-29) — why the unit tests' fireAt() emulation of cron 4.4.0 is faithful, which assertion each mutation turns red, and the heartbeat proof
metadata:
  type: project
---

**fireAt() in tests/unit/core-cron-jobs-dedup.spec.ts is faithful to cron 4.4.0.** Real `callbackWrapper` does
`lastExecution = new Date(); _isActive = false; start(); fireOnTick()`. The emulation skips only `start()`, which
re-arms a timer and changes nothing the service reads (`lastDate()`, `nextDate()` = `sendAt()` from now, `cronTime`).
The Hub's "Run now" is literally `fireOnTick.call(job)` (core-hub-sources.service.ts), so the manual cases use the real
path. `vi.setSystemTime` shifts pending fake timers and fires none, so the armed cron timers never fire by themselves.
A real scheduled fire always has `lastExecution >= sendAt instant`: callbackWrapper fires only when
`Date.now() >= startTime + timeout`, with `timeout` computed BEFORE `startTime`. `getNextDateFrom` truncates ms and
skips the start second, so the step loop breaks at once on a regular fire.

**Mutation verdicts (probed in a clone, --retry=0):** each unit mutation reddens exactly its case;
`cron-bull-jobs-without-options` also reddens the restore test (both assert `opts`). The two review mutations are
verbatim the code of commit 49b3e08. `cron-stale-instant-after-restart` is red on the KEY assertion
(`has('job1:…12:00…')`), not on a double run: in the emulation replica A also skips its 120 intermediate fires and is
stale too, so under the mutation both key on 10:00. The key assertion still pins the mechanism (red in every wrong
configuration).

**Heartbeat proven:** an interval ×3 (no renewal within 65 s) turns the running-lease test red
(`expected ['slow'] to equal []`). E2E `cron-running-lease-e2e-missing` fails first at the running-key assertion
(:225); with that line removed, B's run assertion (:229) fails on its own.

**Fail-open of `acquireRunningLease()`** (no backend → `unlocked`; store throws → `unlocked`) was untested at review
time (both branches switched to `return false` left every suite green); fixed in the same branch with two cases and
mutations `cron-running-lease-closed-without-store` / `cron-running-lease-closed-on-error`.

**Probe trap:** a `grep` with backtick/`${…}` escaping that matched nothing silently broke an `&&` chain, and the
suite ran UNMUTATED and green. Use a node applier that throws unless `find` matches exactly once.

Related: [[cron-bullmq-restore-test-facts]], [[scratch-copy-mutation-check]], [[cross-repo-probe-gotchas]].
