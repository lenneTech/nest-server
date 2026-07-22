---
name: project-pid1-signal-contract
description: Node runs as PID 1 in the reference container and enableShutdownHooks() is never called — so any "remove listener + re-raise signal" pattern is silently swallowed
metadata:
  type: project
---

In the reference container, **Node is PID 1**: `docker-entrypoint.sh` ends with `exec node …/main.js`,
which replaces the shell. This holds in `nest-server` AND in `nest-server-starter`. Nothing adds
`tini` / `--init` / `STOPSIGNAL`.

**Why this matters:** Linux marks a PID-namespace init process `SIGNAL_UNKILLABLE`. A userspace signal
whose disposition is `SIG_DFL` is silently discarded (`sig_task_ignored()` in `kernel/signal.c`).
So the common Node pattern

```js
process.removeListener(sig, handler);   // last listener → disposition back to SIG_DFL
process.kill(process.pid, sig);         // …and at PID 1 this is a NO-OP
```

**terminates correctly in dev but is swallowed in the container.** Verified empirically: as non-PID-1
the process dies with 143; the re-raise only fails at PID 1. Because the HTTP server is still
listening, the event loop is non-empty, so the process does not exit on its own either — `docker stop`
waits out the grace period and SIGKILLs.

`app.enableShutdownHooks()` is **never called** in this repo (grep finds it only inside comments).
Any code branching on `listenerCount(signal) <= 1` therefore always takes the "I am alone" branch —
the "let Nest own the exit" branch is dead code in the reference implementation.

**Why:** noted while reviewing the `process-diagnostics.helper.ts` change set (2026-07-22), whose whole
purpose was making silent deaths diagnosable — this is the one silent death it does not fix.

**How to apply:** whenever reviewing signal handling, shutdown, zero-downtime deploys or graceful
drain in this stack, check all three together — PID-1 status, whether `enableShutdownHooks()` is
actually called, and whether anything drains the event loop. Judging the JS handler alone gives the
wrong answer. Note Nest's own shutdown hooks end with the same `process.kill` re-raise; they work at
PID 1 only because `app.close()` drains the event loop first, not because the re-raise lands.

See [[project-infra-surface]] for the rest of the reference-infra inventory.
