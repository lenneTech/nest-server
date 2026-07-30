---
name: project-pid1-signal-contract
description: SUPERSEDED as of 11.32.0 — tini is now PID 1 and enableShutdownHooks() is called, so the old "signal swallowed at PID 1" analysis no longer describes this repo
metadata:
  type: project
---

**SUPERSEDED 2026-07-30.** Kept only so the old conclusion is not re-derived from a stale note.

**What changed:** release 11.32.0 (commit d0e56d1) added **both** halves of the fix:
- `Dockerfile`: `RUN apk add --no-cache tini` + `ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]`
  → tini is PID 1, the entrypoint shell is PID 2, and `exec $SERVER_CMD` makes node PID 2.
  **Node is no longer PID 1.**
- `src/main.ts:124`: `server.enableShutdownHooks();` is now actually called.

So the previous conclusion — "a `removeListener` + `process.kill(process.pid, sig)` re-raise is
silently discarded because a PID-namespace init is `SIGNAL_UNKILLABLE`, and the loop never drains" —
**no longer applies to the reference container.** tini forwards signals and reaps orphans;
`enableShutdownHooks()` drains the loop via `app.close()`.

**The underlying kernel fact is still true and still worth applying elsewhere:** a signal whose
disposition is `SIG_DFL` is discarded for PID 1 (`sig_task_ignored()`, `kernel/signal.c`), so the
`removeListener` + re-raise pattern is a no-op there. That bites any container that runs node
directly as PID 1 with no init — check `nest-server-starter` and any consumer Dockerfile that
predates 11.32.0 before assuming they inherited this fix.

**How to apply:** when reviewing shutdown / graceful-drain / zero-downtime behaviour in this stack,
still check all three together — is there a real init at PID 1, is `enableShutdownHooks()` called,
and does anything drain the event loop — but for THIS repo the answer to all three is now yes.

See [[project-infra-surface]] for the current reference-infra inventory.
