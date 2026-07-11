---
name: feedback-review-uncommitted-worktree
description: How DevOps/infra reviews are requested in nest-server — diff the uncommitted working tree, don't re-run the check pipeline
metadata:
  type: feedback
---

Release infra reviews in this repo are requested against the **uncommitted working tree on `develop`**, not a committed branch diff.

**Why:** The maintainer stages a release (version bump + changes) in the working tree and asks for review *before* committing. The DevOps-reviewer's documented default `git diff <base>...HEAD` returns EMPTY here and would produce a bogus "No DevOps changes detected / 100%" report.

**How to apply:**
- Enumerate changes with `git diff HEAD` (modified) + `git ls-files --others --exclude-standard` (new untracked) — read untracked files with the Read tool, they are not in any diff.
- The full check pipeline (`scripts/check.mjs`: audit, format, lint, unit+e2e tests, build, server-start) is run by the maintainer *separately* and passes GREEN before review is requested. Do **static review only** — do not re-run tests/build. The prompt states the green result (e.g. "2059 passed").
- See [[project-infra-surface]] for what "infra" actually means in this framework repo.
