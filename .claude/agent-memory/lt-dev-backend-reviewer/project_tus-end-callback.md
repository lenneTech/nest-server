---
name: tus-end-callback-normalization
description: 11.42.2 normalizeEndCallback() in CoreTusService — what was measured about res.end(cb) semantics under srvx/compression, so the same edge cases are not re-derived or re-flagged.
metadata:
  type: project
---

11.42.2 wraps `server.handle` in `createTusServer()` (private, so no subclass can skip it) and patches
`res.end` per response so `res.end(cb)` from srvx's `endNodeResponse` becomes end() + cb on
`finish`/`close`. `compression@1.8.2` crashes only in its STREAM branch (`stream.end(toBuffer(cb))`);
its no-stream branch passes the callback through to native end, which handles it.

Measured on Node 24.12 (scratch script, 2026-10-04):
- Response destroyed BEFORE srvx calls end: native `res.end(cb)` never calls cb, and neither does the
  wrapper (both listeners register after `close` already fired). Pre-existing, not a regression.
- Response already FINISHED before srvx calls end: native calls cb (with ERR_STREAM_ALREADY_FINISHED),
  the wrapper never does. Only reachable if something other than srvx ended the response first —
  nothing in src/core or @tus/server does. Theoretical; consequence is a collectable dangling promise.
- Close AFTER end but before finish: wrapper resolves, native did not — an improvement.

**Why:** these three cases are the "can the srvx promise stay pending" question; answering it took a
runnable script, not reading.
**How to apply:** don't re-flag the destroyed-before-end hang as caused by the wrapper. If a project
middleware that ends responses early (request timeout) appears, the finished case becomes reachable —
fix is `if (this.writableFinished) done()` before registering listeners.
