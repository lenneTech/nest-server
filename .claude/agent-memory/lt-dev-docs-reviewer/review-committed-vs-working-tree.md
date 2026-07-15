---
name: review-committed-vs-working-tree
description: Always run `git status` when auditing a PR here — the author's working tree can hold a newer, better revision than the commits, and a doc↔code contradiction can live entirely in that uncommitted delta
metadata:
  type: feedback
---

When auditing a branch/PR in nest-server, do NOT audit `git diff <base>...HEAD` alone. **Run `git status --porcelain` first** and audit the committed state and the working tree as two separate things.

**Why:** In the 11.27.7 / `fix/better-auth-di-token-circular-import` audit, the initial `gitStatus` context said "clean" (a stale snapshot), but the tree actually had 6 modified files plus an **untracked** `tsconfig.swc-tdz.json`. The uncommitted delta was a *later, better* revision of the same work: committed HEAD had `check:swc-tdz` = `nest build -b swc` (no `-p`), which builds SWC output into the REAL `dist/` (nest-cli has `deleteOutDir: true`) — the exact footgun the working-tree version's own docblock says it fixed by adding `tsconfig.swc-tdz.json` + a throwaway `dist-swc-tdz/`. Reading only `git diff develop...HEAD` would have reported the broken design; reading only the working-tree files would have missed that the fix was never committed. The keystone file being **untracked** meant one `git commit -a` away from shipping a hard-failing `check` script for everyone.

**How to apply:** At the start of every review: (1) `git status --porcelain`; (2) if dirty, diff working tree vs HEAD per file (`git diff -- <file>`) and read the committed version with `git show HEAD:<file>`; (3) call out untracked files that other committed/uncommitted files reference — a `package.json` script pointing at an untracked config is a guaranteed break. Quote file:line from the version you are actually grading, and say explicitly which one that is. See [[migration-guide-behavior-change-count-trap]].
