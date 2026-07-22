---
name: process-diagnostics-helper
description: process-diagnostics.helper.ts semantics verified 2026-07-22 — writeSync(2) throws EBADF/EPIPE and a throw inside uncaughtException exits 7 masking the original; signal abdication is correct vs Nest but unconditional; unhandledRejection flips Node's fail-fast default.
metadata:
  type: project
---

# `src/core/common/helpers/process-diagnostics.helper.ts` — verified behaviour

Public framework API (exported from `src/index.ts`, called from `src/main.ts`), so every consumer
inherits it. Three things were established empirically on 2026-07-22 — re-verify before re-reporting,
but do not re-derive from scratch.

## 1. `writeSync(2, …)` can throw, and that is fatal in the wrong handler

Reproduced: with fd 2 closed, `writeSync(2, …)` throws `EBADF`. Same class applies to `EPIPE`
(stderr is a pipe whose reader exited) and `EAGAIN` (non-blocking pipe under backpressure). A throw
raised **inside** the `uncaughtException` handler makes Node exit with code **7**, printing its own
"throw inside handler" message and **destroying the original diagnostic** — the exact opposite of the
helper's purpose. From the `unhandledRejection` handler the throw escalates to `uncaughtException`,
so a survivable rejection becomes a hard crash. Fix is a `try {} catch {}` around the sink.

## 2. Signal abdication is correct against Nest, but unconditional

`listenerCount(signal) <= 1 → removeListener + reraise` was traced against
`@nestjs/core/nest-application-context.js#listenToShutdownSignals`: Nest's cleanup removes its own
listener and then `process.kill(process.pid, signal)`, at which point the diagnostics handler is
alone, removes itself and re-raises → clean termination. The re-raise loop is correctly broken.

Two caveats: (a) the abdication does not care **who** the other listener is — any library listener
that never exits turns SIGTERM/SIGINT into a no-op while the helper still logs a reassuring
"external termination" line; (b) `installedTargets` is a module-level `WeakSet`, so two copies of the
package (dual CJS/ESM instance, un-deduped install) each install a listener on the same `process`,
both see count 2, both abdicate → unkillable by SIGTERM. `src/main.ts` does **not** call
`enableShutdownHooks()`, so in this repo the helper is the sole listener and the path is fine.

## 3. `unhandledRejection` flips Node's default from fail-fast to fail-open

Since Node 15 the default is `--unhandled-rejections=throw` (rejection → uncaughtException → crash).
Installing a log-only handler makes the process **survive** unknown-state rejections. Deliberate and
documented in the helper, but it is a security-relevant default change shipped to every consumer:
combined with an unbounded, unredacted sync write it also becomes a log-flood / event-loop-stall
vector if an attacker can trigger a rejecting promise per request.

**Note:** `describeError()` returns only `message` + `stack` — it does NOT dump own enumerable
properties the way `console.error`/`util.inspect` would. So `AxiosError.config.headers`,
`BrevoError.rawResponse` etc. are **not** printed. The leak surface is limited to error *messages*
and stacks. The framework already ships `redactSensitiveText()` (`logging.helper.ts`, used by the
Hub log buffer / mailbox / query profiler) — this sink does not use it, and deliberately bypasses
the Nest logger, so Hub capture and structured-log redaction do not apply.

Related: [[project-hub-module-security-model]]
