---
name: tus-end-normalizer-costs
description: Measured cost/leak profile of CoreTusService.normalizeEndCallback (11.42.2) and the HTTP bench-harness traps on this shared machine (HEAD closes Agent sockets -> port exhaustion)
metadata:
  type: project
---

`CoreTusService.normalizeEndCallback()` (11.42.2) wraps `res.end` per tus request and adds `once('finish')` + `once('close')`.
Measured 2026-10-04 on Node 24.12.0 with Express + compression + @tus/server 2.4.5 / srvx 0.11.15:

- ~100-180 ns extra per request (once per response, never per body chunk — only `res.end` is touched).
- Server-socket listener set constant over 2000 keep-alive HEADs / 200 PATCHes (listeners live on the per-request `res`, not the socket).
- Heap delta identical native vs wrapped (~1.2-1.4 MB warm-up, flat in N).
- 200 client-aborted PATCHes: every `handle()` settled, every `res` GC'd, in both modes.
- `res.end(cb)` AFTER `res` already emitted `close`: the callback never fires — in native Node too, so the wrapper is parity, not a regression. Its comment ("a dropped connection cannot leave srvx waiting") only holds for a drop AFTER `end()`.

**11.42.9 hook additions (measured 2026-10-07):** `@tus/server` 2.4.5 calls `onIncomingRequest` once
per HEAD/GET/PATCH/DELETE/POST REQUEST (PatchHandler: before `getConfiguredMaxSize`/lock/`getUpload`),
never per body chunk. The added `assertExtensionEnabled()` (Set build + content-type read via srvx
`NodeRequest.headers.get`) costs ~150 ns per request; `uploadCollectionPath()` (`new URL`) ~550 ns once
per creation. A FileStore `getUpload` (stat + JSON read) is ~120 us on the same box, so hook work
below ~1 us per request is <1% of the PATCH fixed cost before any body bytes move.

**Why:** re-reviews of tus changes should not re-derive this; flag only if the wrapper starts touching `write`/the request stream.

**How to apply — bench harness traps:**
- Node's `http` client closes the keep-alive socket after every HEAD response, so a HEAD loop through `http.Agent` opens one connection per request and exhausted all 16k macOS ephemeral ports (EADDRNOTAVAIL, ~15 s to drain) on this SHARED machine. Use one raw `net` socket and hand-parse the response.
- tus POST answers `Transfer-Encoding: chunked` with an empty body (`0\r\n\r\n`); a raw parser must strip it.

Related: [[gridfs-verify-and-stream-costs]], [[s3-upload-paths-costs]]
