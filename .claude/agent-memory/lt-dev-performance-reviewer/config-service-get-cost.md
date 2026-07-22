---
name: config-service-get-cost
description: Measured cost of ConfigService.get() vs getFastButReadOnly() — why a per-request config read is cheap but not free
metadata:
  type: project
---

`ConfigService.get(key)` is **~152 ns/call** for a scalar value (measured 2026-07-22, Node 24, M-series).

**Why it is not ~80 ns:** `get()` is `clone(_.get(subject.getValue(), key), { circles: false })`, and `clone()`
(`src/core/common/helpers/clone.helper.ts`) does three things per call, none of them cached:

| Component | ns/call |
|-----------|---------|
| `_.get()` (dotted path walk) | 79 |
| `rfdc({...})` — **factory rebuilt every call**, not memoized | 69 |
| `inspector.url()` (for the `debug` flag) | 11 |

Plus `util.isDeepStrictEqual(object, cloned)` when `checkResult` is on (default).

`ConfigService.getFastButReadOnly(key)` skips the whole clone (`_.get` on the pre-frozen subject) and is
the ~79 ns option — correct whenever the caller only reads a scalar and never mutates the result.

**How to apply:** 152 ns is irrelevant on a request path (LLM round-trip, DB query, HTTP). Do NOT flag a
config read in a resolver/service as a finding. It only matters if a `ConfigService.get` ends up inside a
per-item loop (per tool, per document, per array element) — there, prefer hoisting the read out of the
loop or using `getFastButReadOnly`. Related: [[ai-module-perf]].

Second measured framework micro-fact from the same session: `CoreAiService.translate()` rebuilds its whole
`messages` object literal (7 entries, 2 with template-literal interpolation) on **every** call —
**~13 µs/call**, ~85× a `ConfigService.get`. Called ≤3× per prompt, so it is noise today; it would become
real if it ever moved into a per-tool or per-message loop.
