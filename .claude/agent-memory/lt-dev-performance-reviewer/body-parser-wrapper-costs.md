---
name: body-parser-wrapper-costs
description: Measured per-request cost of CoreBodyParserInitializer's parser wrapper (11.42.4) and how body-parser's 413 path drains before next(); reuse before flagging parser-layer changes.
metadata:
  type: project
---

Measured 2026-10-06 (body-parser 2.3.0, express 5.2.1, router 2.2.0) against the compiled
`dist/core/common/services/core-body-parser.initializer.js`:

- Wrapper around `express.json()` adds **~8-16 ns per bodyless request** (GET: 24-28 ns raw vs
  33-41 ns wrapped) and nothing measurable on a small JSON POST (~2.4 us both). O(1), one closure.
- Wrapper keeps `name === 'jsonParser'` and `length === 3` (length 4 would make router treat it as
  an error handler — check this on any future wrapper).
- The swap runs in `onModuleInit`, which `NestApplication.init()` calls AFTER
  `registerParserMiddleware()` + `registerRouter()` and before `listen()` — no request sees the
  unswapped stack.
- 413 path: body-parser `dump()`s the request (drains, or waits for close) BEFORE calling next, so
  the added warn log fires once per already-rejected request — bounded by request rate, never on
  the success path. Not a log-amplification finding.
- Default limit stays 100 kB; a raised limit costs synchronous JSON.parse (~16 ms / 1 MB per the
  author's measurement) — opt-in, not a regression.

**Why:** a reviewer of parser-layer changes otherwise re-derives all of this.
**How to apply:** for future body-parser / middleware-wrapper diffs, re-check name/length
preservation and init order; do not flag the wrapper overhead or the 413 log line.
Related: [[auth-gate-per-request-cost]], [[tus-end-normalizer-costs]].
