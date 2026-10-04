---
name: tus-compression-end-callback-facts
description: Which TUS responses hit the srvx res.end(callback) vs compression defect (11.42.2), how the mutation goes red (hang, not 500), and the Accept-Encoding precondition
metadata:
  type: project
---

Facts verified 2026-10-04 by standalone repro (@tus/server 2.4.5, srvx 0.11.15, compression 1.8.2) while reviewing `tests/tus-compression.e2e-spec.ts` (mutation `tus-end-callback-unnormalized`).

- srvx calls `res.end(resolve)` ONLY for a null body. tus nulls the body for 204/205/304, so the affected responses are **every** PATCH (intermediate too), OPTIONS and DELETE. POST 201 (body `''`) and HEAD 200 (body `''`) take `streamBody` -> `res.end()` with no callback and are never affected. A spec that only creates uploads cannot catch it.
- The trigger needs BOTH `filter: () => true, threshold: 0` (the starter's main.ts) AND an `Accept-Encoding` the client sends. Without that header compression creates no stream and the defect is invisible. When reviewing a test for this, check that it sends the header.
- Under the defect the response is **never answered** (`handle()` rejects with ERR_INVALID_ARG_TYPE "Received function"; headers are already stored, so the controller's `!res.headersSent` 500 branch does not fire). The client sees a hang, not a 500, whatever the README/migration-guide wording says.
- Consequence for the mutation run: the spec goes red by testTimeout x (1+retry), and afterAll's `server.close()` waits on the hung keep-alive socket until hookTimeout. That costs ~5 min per run and leaks the `tus-gzip-*` mkdtemp dir in os.tmpdir. The verdict is still valid. Don't misread the leftover dirs as a cleanup bug in the green path, where cleanup works.

**How to apply:** for any future test pinning middleware/`res.end` interplay on TUS, assert on a 204-class response with Accept-Encoding set. Related: [[e2e-isolation-model]].
