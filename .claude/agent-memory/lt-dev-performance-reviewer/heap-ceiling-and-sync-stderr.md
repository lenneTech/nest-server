---
name: heap-ceiling-and-sync-stderr
description: Measured facts about the nodemon heap ceiling (a no-op on 32GB hosts) and why writeSync(2) in routine process handlers is an availability risk, not a CPU one.
metadata:
  type: project
---

Two measured facts behind the 2026-07-22 "silent crash" change set (`process-diagnostics.helper.ts`
+ `nodemon.json` `NODE_OPTIONS`). Both were counter-intuitive and cost real measurement time.

## 1. `--max-old-space-size=4096` is a NO-OP on a 32 GB host

Measured on Node v24.12.0 / 32 GB (`v8.getHeapStatistics().heap_size_limit`):

| flag | heap_size_limit |
|---|---|
| default | **4288 MB** |
| `--max-old-space-size=4096` | **4288 MB** (identical) |
| `--max-old-space-size=2048` | 2240 MB |
| `--max-old-space-size=8192` | 8384 MB |

V8 already defaults old-gen to its 4 GB cap on any host with >= ~16 GB RAM. So the `nodemon.json`
ceiling changes nothing on the dev machine where the crash was observed. It only bites on
smaller hosts — where it *raises* the ceiling, i.e. the opposite of the stated intent.

**Why:** the ceiling was added to turn a silent OOM SIGKILL into a loud Node "heap out of memory".
It cannot do that if it equals the default.

**How to apply:** never accept a `--max-old-space-size` value as a mitigation without measuring
`heap_size_limit` with and without it on the target host class. Also note `nodemon.json`'s `env`
block *replaces* an inherited `NODE_OPTIONS` rather than appending, and `nodemon-debug.json`
(`start:debug`) does not carry the same setting.

## 2. Production has NO explicit ceiling — and that is CORRECT, not a gap

`Dockerfile`, `docker-entrypoint.sh` and `start:prod` all run bare `node`. That is deliberate-by-
accident and should stay: Node reads `uv_get_constrained_memory()` (the cgroup limit) and sizes the
default heap from it, but **only when `--max-old-space-size` is unset**. Pinning 4096 in a
512 MB container would disable that auto-sizing and hand the kill back to the OS OOM-killer —
reintroducing exactly the undiagnosable SIGKILL. `process.constrainedMemory()` reports the
container limit on Linux (returns 0 on macOS).

**How to apply:** if a production ceiling is ever requested, it must be derived from the container
limit (~75 %), never a fixed literal.

## 3. `writeSync(2, …)` BLOCKS INDEFINITELY on a stalled stderr pipe

Measured: a child whose stderr is an un-drained pipe hung after < 64 KB (macOS pipe buffer) and had
to be SIGKILLed. The whole event loop stalls — every in-flight HTTP request with it.

CPU cost is irrelevant: 1.61 µs per 1 KB line to a drained sink = 0.16 % of one core at
1000 writes/s. **The risk is backpressure, not throughput.**

Corollary measured on `installProcessDiagnostics()`: `process.listenerCount('warning')` goes 1 → 2,
because Node's own warning printer is still attached — every process warning is emitted twice, one
of them synchronously.

**How to apply:** `writeSync` is right for *terminal* handlers (`uncaughtException`, `exit`,
signals, fatal bootstrap) where blocking is acceptable and delivery must be guaranteed. It is wrong
for *routine* handlers (`warning`, `unhandledRejection`) that fire during normal operation — those
belong on async `console.error`, ideally rate-limited/deduped.

Related: [[ai-module-perf]], [[hub-module-perf]]
