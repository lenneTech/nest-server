---
name: gridfs-verify-and-stream-costs
description: Measured costs for the GridFS upload-verify + download-pipe paths — COUNT_SCAN is index-only but O(chunks), MongoClient connect/close is ~43ms/file on localhost, pipe() leaks the source on client abort, and process.exit() truncates piped stdout at 64 KB.
metadata:
  type: project
---

Measured 2026-07-30 on Node v24.12.0 / local mongod, while reviewing the GridFS
upload-verification + download-pipe change set. All four were counter-intuitive enough to be
worth not re-deriving.

## 1. `countDocuments({files_id})` DOES use the GridFS default index — but scans one key per chunk

GridFS auto-creates `{files_id: 1, n: 1}` (unique, background) on `<bucket>.chunks`. The driver's
`countDocuments` compiles to `$match` + `$group`, and MongoDB optimizes that into **COUNT_SCAN**:

| file | chunks | stage | keysExamined | docsExamined |
|---|---|---|---|---|
| 10 KB | 1 | COUNT_SCAN | 1 | **0** |
| 50 MB | 201 | COUNT_SCAN | 201 | **0** |
| 30 MB @1KB | 30720 | COUNT_SCAN | 30720 | **0** |

So it is index-only (never touches documents) but **O(chunks) in index keys**. The bounded
alternative `findOne({files_id}, {sort:{n:-1}, projection:{_id:0,n:1}})` is **PROJECTION_COVERED
with keysExamined = 1** regardless of size, and detects the same realistic failure mode (GridFS
writes `n` as a 0..N-1 prefix, so a partial upload truncates the tail).

**Watch the missing-index case:** a bucket whose chunks collection was non-empty at first upload
never gets the index (driver skips creation) → the same count becomes a **COLLSCAN** over the whole
chunks collection. Verified by pre-seeding a decoy chunk doc.

**Gotcha:** `expected = Math.max(1, ceil(length/chunkSize))` is wrong for a **0-byte file** —
GridFS stores **0** chunks for it, so the `max(1, …)` floor makes a valid empty file look incomplete.

## 2. `MongoClient.connect()` per file costs ~43 ms — close() costs ~0.4 ms

Measured p50 over 40 iterations, localhost, **no TLS, no auth, no SRV**:

| shape | p50 |
|---|---|
| connect + op + close (per-file) | **44.1 ms** |
| shared client, op only | **0.73 ms** |
| `close()` alone | **0.43 ms** |

So per-file connect/close overhead is ~43 ms and is **~100x the cost of the two verification
queries** (~0.4 ms combined). Adding `close()` is nearly free; the *connect* is the expensive half,
and it predates the verification work. A `mongodb+srv://` + TLS + SCRAM target adds SRV/TXT DNS,
TLS and 2 SCRAM round trips on top — treat 43 ms as a **floor**, not the production number.

Leaving clients open (the old shape) cost 84 active handles for 40 files and kept the event loop
alive forever — the "migrate up never exits" symptom.

**How to apply:** N-file migration loops should share one client keyed by URI. `getDb()` in
`migration.helper.ts` has the same per-call connect shape.

## 3. `pipe()` installs its error handler on the DESTINATION only — and never destroys the source

Verified with listener counts and abort simulation:

- `src.pipe(dst)` → `src.listenerCount('error')` stays **0**, `dst` goes to **1**. A source error is
  therefore unhandled unless you add your own handler.
- **Destination destroyed mid-stream (client aborts a download) → `source.destroyed === false`,
  still holding its buffered chunks (64 KB in the harness).** With a GridFS read stream that is also
  a live server-side cursor. One leak per aborted download.
- `stream.pipeline(src, dst, cb)` destroys the source automatically in the same scenario.

**How to apply:** handling only the source-error direction is half the fix. For download endpoints,
`pipeline()` covers both directions; downloads are exactly where client aborts are common.

## 4. `process.exit()` truncates piped stdout at the 64 KB kernel pipe buffer

Against a deliberately slow consumer, a process writing ~450 KB then calling `process.exit(0)`
delivered exactly **65500 bytes** — everything past the pipe buffer was discarded. The identical run
without `process.exit()` lost nothing (it correctly blocked until drained).

Below ~64 KB of pending output it is **not** reachable — writes land in the kernel buffer
synchronously. It is also **load-dependent**: on an idle machine 5000 lines survived 10/10 runs; the
one truncation to 3426 lines happened while the box was saturated by a concurrent test suite.

**How to apply:** stdout to a **file or TTY** is safe; a **pipe** is not — and Docker's log driver
and CI log shippers are pipes. A CLI that must exit explicitly should flush first
(`process.stdout.write('', cb)`) rather than exit inline. Never dismiss this as theoretical because
"it worked locally" — local usually means a TTY.

Related: [[migrate-module-perf]], [[heap-ceiling-and-sync-stderr]]
