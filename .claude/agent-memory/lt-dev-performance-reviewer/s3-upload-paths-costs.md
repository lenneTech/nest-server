---
name: s3-upload-paths-costs
description: Measured buffering bound of @aws-sdk/lib-storage Upload (3.1143.0), which S3 request bodies the SDK retries, and the 5 GiB single-PUT ceiling behind CoreS3Service.putObject's known-length path
metadata:
  type: project
---

Measured 2026-10-03 (Node 24.12, lib-storage 3.1143.0, fake client, no network) while reviewing the
streamed-S3-upload change (11.41.7). Re-derive only if lib-storage's major/minor behaviour changes.

## 1. lib-storage `Upload` memory bound HOLDS — about 20 MiB per upload, independent of size and latency

Metric: bytes read from the source minus bytes acknowledged by a completed UploadPart (= live buffered
data, excludes GC lag). Same result for 512 MiB and 2 GiB, part latency 5 / 30 / 500 ms:
`maxInflightParts: 4`, `maxReadAhead: 20.13 MiB` (4 x 5 MiB + one 64 KiB source chunk; 22 MiB with
1 MiB chunks). The generator stops pulling while all 4 workers are busy, so backpressure is real.

`process.memoryUsage().arrayBuffers` peaks of 56-152 MiB in the same runs are uncollected garbage
(sublinear in size, drop to 66-86 MiB with forced GC). Do NOT report those as a leak.

Also: a stream ending within 5 MiB is ONE PutObject with a Buffer body (verified: 3 MiB → put:1, no
create/complete). `getChunkStream` is zero-copy when the source yields one big Buffer
(`Readable.from(buffer)`): it slices `chunks[0]` without concat.

## 2. The SDK never retries a STREAM request body

`@smithy/core` retry middleware: `isStreamingPayload(request)` (body instanceof Readable / web
ReadableStream) → throws on the first error, logs "An error was encountered in a non-retryable
streaming request." So: Buffer-body PutObject and every lib-storage part = retried (3 attempts);
`putObject(stream, knownLength)` = single attempt. Switching a path from Buffer to stream silently
drops transient-error protection (503 SlowDown, stale keep-alive ECONNRESET). Relevant when a
source is ALREADY in memory (multer memoryStorage) — streaming it buys no memory there.

## 3. Known-length path is a single PutObject — AWS caps that at 5 GiB

`putObject` sends any known length as one PUT. AWS S3 rejects > 5 GB with EntityTooLarge;
RustFS/MinIO (the test store) do not, so tests cannot catch it. As of 2026-10-03 the TUS fallback for
uploads above `MAX_COPY_OBJECT_BYTES` streams into exactly that path. lib-storage `Upload` with
`params.ContentLength` set handles it (partSize auto-raised to ceil(total/10000)).

Related: [[gridfs-verify-and-stream-costs]]
