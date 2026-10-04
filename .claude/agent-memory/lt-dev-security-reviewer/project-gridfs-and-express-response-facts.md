---
name: project-gridfs-and-express-response-facts
description: Verified library behaviors that keep biting the file-download and migrate-GridFS paths — GridFS stores ZERO chunks for a 0-byte file, Express res.json() never overrides an already-set Content-Type, stream.pipe() does not destroy the source on client abort, process.exit() truncates piped stdout, and res.end(cb) never calls cb once the socket died before end().
metadata:
  type: project
---

# Five verified behaviors behind the file/GridFS/CLI paths

Items 1-4 were confirmed empirically on 2026-07-30 (Express 5.2.1, mongodb driver in-tree,
Node 24.12) while reviewing `core-file.controller.ts` + `migration.helper.ts`. They are library
facts, not project code, so they stay true across refactors — and each one has already produced a
real defect here.

1. **GridFS writes NO chunk document for a zero-byte file.** Driver source
   `node_modules/mongodb/lib/gridfs/upload.js` → `writeRemnant()` returns early on `stream.pos === 0`
   ("Buffer is empty, so don't bother to insert"). Only the `.files` doc with `length: 0` is stored.
   Any chunk-count verification of the shape `Math.max(1, Math.ceil(length / chunkSize))` therefore
   **rejects valid empty files**. The correct expected count is plain
   `Math.ceil((length || 0) / chunkSize)` — which is 0 for an empty file.

2. **`res.json()` does NOT override an already-set `Content-Type`.** Express guards it with
   `if (!this.get('Content-Type'))`. On a file-download route that already set
   `Content-Type: image/png`, an error-path `res.status(404).json(...)` ships a JSON body labelled
   `image/png; charset=utf-8`. `res.send()` DOES fix `Content-Length` and regenerates a correct
   weak `ETag`, so those two are not stale — Content-Type is the only header that lies.

3. **`stream.pipe(res)` does not destroy the SOURCE when the client aborts.** Node's pipe only
   `unpipe()`s. A public download endpoint therefore leaks one GridFS read stream + cursor per
   aborted request. Needs an explicit `res.on('close', () => stream.destroy())`.

4. **`process.exit()` truncates piped stdout.** Reproduced: 60 001 `console.log` lines → only 18 662
   reached the pipe, 4.87 MB still in `process.stdout.writableLength`, and the final
   "completed successfully" line was lost. Node's stdout is async on a pipe, which is exactly what
   Docker/CI/`| tee` give you. Relevant wherever a CLI's output IS the audit record (migrate).

5. **`res.end(callback)` never calls the callback when the client disconnected BEFORE `end()`.**
   Native Node: `_writeRaw` returns early on a destroyed socket, so `finish` never fires, and the
   `close` event has already been emitted. Probed 2026-10-04 (Node 24, compression 1.8): native, and
   the 11.42.2 `CoreTusService.normalizeEndCallback()` wrapper, both -> 0 calls; abort AFTER end -> 1
   call. srvx's `endNodeResponse()` (`new Promise(r => res.end(r))`) therefore stays pending on that
   race — an unreachable, GC-collectible island, not a leak, and upstream behaviour. Separately,
   `compression`'s patched `res.end(chunk, encoding)` treats a function first argument as a chunk
   and throws `ERR_INVALID_ARG_TYPE` — the 11.42.2 defect. A JSDoc saying listening on `close`
   means "a dropped connection cannot leave srvx waiting" is only true for a drop AFTER end().

**How to apply:** when a change adds chunk-count verification, an error path on a streaming
response, a `pipe()` to a response, or an explicit `process.exit()`, check it against the matching
item above before accepting the accompanying comment or unit test. Stub-based unit tests
(`responseStub`, `dbStub`) cannot catch 1, 2 or 3 — items 1 and 2 both slipped through green specs
that asserted the *wrong* behavior.

Related: [[project-exception-wire-format]], [[project-process-diagnostics-helper]]
