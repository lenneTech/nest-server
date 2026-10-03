---
name: s3-streaming-uploads
description: 11.41.7 S3 upload streaming (lib-storage multipart, FileUploadSource.size) — what was verified sound, and the open 5 GiB single-PUT ceiling
metadata:
  type: project
---

Reviewed 2026-10-03 (11.41.6 → 11.41.7, uncommitted on `develop`, from DEV-2818): `createFile()` no longer
buffers S3 uploads; known length → one streamed PutObject, unknown → `@aws-sdk/lib-storage` `Upload`
(optional peer), no peer → buffered as before.

**Verified sound — do not re-flag:**
- A failed `Upload` does NOT strand its source stream. Exiting `for await` by throw calls the generator's
  `return()`, and Node's Readable iterator destroys the stream on early return. Reproduced with a real
  fs-capacitor stream + CreateMultipartUpload refused: `body.destroyed=true`, temp file deleted on
  `release()`. (GridFS needs its explicit `stream.destroy()` because it uses `pipe()`; lib-storage does not.)
- `Upload` sizes the body via `byteLength()` (`.byteLength/.length/.size/.start+.end`, or statSync for an
  `fs.ReadStream`). fs-capacitor ReadStream exposes none → unknown → 5 MiB parts. GridFS read stream's
  `start`/`end` are METHODS, so not misread. A filesystem-store duplicate (fs.ReadStream) gets an exact stat.
- Vendor mode: the CLI closure scan (`gatherVendorCoreImportClosure`) picks up dynamic `import('x')` calls
  at FRESH vendoring; the updater agent's Phase 7b only raises packages already listed, so an UPDATE needs
  the manual install the migration guide documents.

**Open (reported High):** any KNOWN length goes to a single PutObject regardless of size; AWS S3 / Ceph RGW
refuse a single PUT above 5 GiB. Pre-existing for TUS (default `maxSize` 50 GiB, incl. the ">5 GB → stream
instead of CopyObject" fallback), newly reachable via `FileUploadSource.size` and its `stat()` guidance.
Fix = route `length > 5 GiB` streams to the multipart branch with `ContentLength` passed to `Upload`.

**Why:** so a follow-up review does not re-derive the lib-storage cleanup trace or re-flag the stream leak.
**How to apply:** when this area is reviewed again, check whether `putObject()` gained a size ceiling.
