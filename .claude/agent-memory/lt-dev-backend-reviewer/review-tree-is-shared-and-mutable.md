---
name: review-tree-is-shared-and-mutable
description: During /lt-dev:review the working tree is shared with parallel reviewer agents and can carry check-mutations residue; never git stash, diff files individually instead.
metadata:
  type: project
---

Reviewing UNCOMMITTED changes in this repo happens in a working tree that is **shared and actively
mutating**: `/lt-dev:review` runs several reviewer agents concurrently against the same checkout, and
they write `.claude/agent-memory/**` files while you work. `git status` therefore differs between two
consecutive calls for reasons that have nothing to do with the diff under review.

**Why:** observed 2026-08-22 reviewing 11.36.3. Two source files
(`src/core/common/services/core-s3.service.ts`, `src/core/modules/file/core-file-access-audit.initializer.ts`)
carried APPLIED mutations from an interrupted `scripts/check-mutations.mjs` run — that script edits
source in place. This made 6 unit tests red and looked exactly like a regression introduced by the
diff. It was residue, not the change.

**Correction (same session, established afterwards):** the two files had DIFFERENT causes, and the
distinction changes the remedy. `core-s3.service.ts` was true leftover residue from an earlier
interrupted run — a systematic scan of all 51 registry entries at the START of the review found it
and nothing else. `core-file-access-audit.initializer.ts` was **transient state of a `check:mutations`
run that was live at that moment**, started in the background by another agent.

That matters: reverting a file a RUNNING mutation check is currently using corrupts that run's
verdict — it can turn a real red into a false PASS, which is the one outcome the whole gate exists to
prevent. So before reverting anything, check whether a run is in flight (`ps aux | grep
check-mutations`). If it is, WAIT; only a leftover from a dead run may be reverted.

**How to apply:**
- **Never `git stash` to get a clean baseline.** `git stash pop` fails when the stash also carried
  untracked files that have since reappeared, and a failed pop applies PARTIALLY — it silently
  reverted a source file mid-review. Back untracked files up first if you ever must, and verify with
  `git diff HEAD --stat` against your own first measurement.
- To separate "diff caused it" from "residue", revert the SUSPECT FILES ONLY
  (`git checkout HEAD -- <file>`) and re-run — never the whole tree.
- When unit tests fail, first check whether the failing test's target file is itself modified in the
  tree. A `regression-evidence.spec.ts` failure saying ``find` matched 0 times` almost always means
  the mutation is already applied to the source, not that the registry rotted.
- Take `git diff HEAD --stat` as your own baseline at the start and compare against it at the end;
  the session-start snapshot in the prompt is already stale.
