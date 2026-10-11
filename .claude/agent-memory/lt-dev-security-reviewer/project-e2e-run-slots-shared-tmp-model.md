---
name: project-e2e-run-slots-shared-tmp-model
description: tests/e2e-run-slots.ts shared-/tmp threat model after the 2026-10 hardening — write path closed, squatted-dir read-path FIFO hang is pre-existing and below bar
metadata:
  type: project
---

Reviewed 2026-10-11 (uncommitted hardening ported from nest-server-starter 46b9ac2). Test infra only, never ships.

Closed by the hardening (verified with a probe, not by reading):
- `writeFileSync(..., { flag: 'wx' })` refuses a planted symlink, dangling ones too (EEXIST) — the unlink→write race lands in EEXIST → caught → fail-open, never a followed write.
- `claimOwnSlot()` (incl. its `mkdirSync`) sits inside the try in BOTH call sites, so an unwritable/squatted dir now degrades to "ungoverned run" instead of aborting global-setup (pre-diff that WAS a cross-user DoS).

Residual, pre-existing, below bar (do not re-report unless a diff touches the read path):
- `mkdirSync(..., { mode: 0o700, recursive: true })` does NOT re-mode an existing dir: an attacker who creates `/tmp/lt-e2e-run-slots` first keeps it 0777 (comment admits this).
- In such a squatted dir, `activeRuns()` reads `<pid>.slot` with `readFileSync` (follows links, opens FIFOs): a FIFO named after one of the victim's LIVE pids blocks config load indefinitely. Only the victim's own pids reach the read: `process.kill(pid, 0)` returns EPERM for foreign-user pids → treated as dead → unlinked.
- Dir-level symlink in /tmp is blocked on Linux by `fs.protected_symlinks=1`; without it, unlinks are still limited to `<int>.slot` names.

**How to apply:** if a later diff touches `activeRuns()`'s read, check whether it adds `O_NOFOLLOW`/`lstat` + `isFile()` before reading; that is the only remaining gap and the one hardening step that would close the FIFO hang.
