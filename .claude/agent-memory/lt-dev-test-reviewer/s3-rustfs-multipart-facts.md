---
name: s3-rustfs-multipart-facts
description: Empirically verified behaviour of the test S3 store (RustFS 1.0.0-rc.1, port 9102) and @aws-sdk/lib-storage that decides whether S3 multipart test assertions can actually go red
metadata:
  type: project
---

Verified 2026-10-03 against `nest-server-2985-rustfs` (rustfs/rustfs:1.0.0-rc.1) with `@aws-sdk/lib-storage` 3.1143.0, while reviewing the streamed-S3-upload change (11.41.7):

- **RustFS lists in-progress multipart uploads WITHOUT a `Prefix`.** `ListMultipartUploadsCommand({ Bucket })` returned the pending upload left by `new Upload({ leavePartsOnError: true })`. So an assertion "no pending uploads after a failed upload" is NOT vacuous here. Do not assume this for MinIO-style stores in general: historically MinIO returned an empty list unless the exact object key was given as prefix. If the test store ever changes, re-verify before trusting such an assertion.
- **lib-storage's abort is deterministic, not timing-dependent.** `__doMultipartUpload` awaits ALL concurrent part uploaders (each `.catch`-wrapped) before `markUploadAsAborted()`, and `uploadId` is set by then. A source stream that errors after the first full part (>5 MiB) always rejects with the SOURCE error and aborts the upload (default `leavePartsOnError: false`).
- **An empty stream through `Upload` works**: `Readable.from([])` stores an object with `ContentLength 0` (single PutObject). Relevant because `isKnownUploadSize(0)` is false, so 0-byte TUS/multer uploads now take the multipart path.

**How to apply:** when reviewing S3 upload tests, these three facts settle the usual vacuity/flake questions without another probe. To re-probe, write a CJS script in the scratchpad that resolves `@aws-sdk/client-s3` / `@aws-sdk/lib-storage` with `require.resolve(..., { paths: [repo] })`, uses a throwaway bucket, and aborts + deletes in `finally`. See [[check-gate-coverage-blind-spots]] for what `check` cannot see.
