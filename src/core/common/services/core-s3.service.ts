import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PassThrough } from 'stream';

import { buildContentDisposition } from '../helpers/content-disposition.helper';
import { ConfigService } from './config.service';

import type { IS3Config } from '../interfaces/server-options.interface';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

/**
 * Hard cap for a presigned download URL, in seconds.
 *
 * This is the ceiling AWS SigV4 itself enforces (7 days) — a longer `expiresIn` produces a
 * signature S3 rejects outright, so a value above it can never work, only fail later.
 */
const MAX_PRESIGNED_EXPIRY_SECONDS = 604_800;

/**
 * Above this, the TTL is very likely longer than intended.
 *
 * A presigned URL is a SESSION-LESS bearer capability: it is authorized once, at issue time, and
 * from then on anyone holding the string can download the object — no token, no session, no role
 * check, and no way to revoke it short of deleting the object or rotating the credentials that
 * signed it. Such links end up pasted into chats, tickets and proxy logs, so the window in which a
 * leak is exploitable is exactly this number. The cap above only catches the impossible value; the
 * dangerous band lies well below it, which is why it gets its own warning rather than silence.
 */
const PRESIGNED_EXPIRY_ADVISORY_SECONDS = 900;

/**
 * Fully normalized S3 configuration with defaults applied
 */
export type NormalizedS3Config = Omit<IS3Config, 'enabled' | 'presignedDownloads'> & {
  bucket: string;
  forcePathStyle: boolean;
  /** undefined = presigned downloads disabled */
  presignedDownloads?: { expiresInSeconds: number };
  region: string;
  stagingBucket: string;
};

/**
 * Central S3-compatible object storage service (see IServerOptions.s3).
 *
 * Works with AWS S3, MinIO, RustFS and other S3-compatible services. Used by
 * CoreFileService (file.storage: 's3') and as TUS upload staging. Follows the
 * "presence implies enabled" pattern: without an `s3` config this service is
 * inert and files stay in GridFS / on local disk as before.
 *
 * The `@aws-sdk/client-s3` package is an OPTIONAL peer dependency and is
 * lazy-imported at bootstrap; `@aws-sdk/s3-request-presigner` is only needed
 * when `presignedDownloads` is enabled.
 */
@Injectable()
export class CoreS3Service implements OnApplicationShutdown, OnModuleInit {
  protected readonly logger = new Logger(CoreS3Service.name);

  /** Normalized config; undefined when S3 is not enabled */
  protected config?: NormalizedS3Config;

  /** Shared S3 client, created at init */
  protected client?: S3Client;

  /** Lazy-imported @aws-sdk/client-s3 module (command classes) */
  protected sdk?: typeof import('@aws-sdk/client-s3');

  /**
   * Lazy-imported @aws-sdk/s3-request-presigner, cached after the first presigned URL.
   *
   * Node's module cache already makes a repeated `import()` cheap, but it is still a promise
   * allocation and a resolver hop on a per-download path — and it obscures that the module is
   * loaded once, not per request.
   */
  protected presigner?: typeof import('@aws-sdk/s3-request-presigner');

  /**
   * Lazy-imported `@aws-sdk/lib-storage`, used to upload a stream whose length is unknown.
   *
   * Three states, and the third is the point: `undefined` means "not tried yet", a module means
   * "available", and `null` means "tried and absent". Without the `null` the import would be
   * retried on every single upload, and since the absence is permanent that is a resolver miss per
   * request plus a repeated warning in the log.
   */
  protected multipartUploader?: null | typeof import('@aws-sdk/lib-storage');

  constructor(protected readonly configService: ConfigService) {
    const raw = this.configService.getFastButReadOnly<IS3Config | undefined>('s3');
    if (!raw || raw.enabled === false) {
      return;
    }

    // A bucket is the one thing S3 cannot default — region, endpoint and
    // credentials all have fallbacks, "which bucket" does not. Without it the
    // service can neither store nor stage anything, so it must not report itself
    // enabled: `tus.s3Staging` defaults to true and keys off exactly this flag,
    // so a bucket-less `s3` block used to switch tus staging on and then fail at
    // the first upload with `stagingBucket: undefined`. It also kept this flag
    // out of step with `resolveFileStorage()`, which has always required a
    // bucket — the file module chose GridFS while tus chose S3.
    if (!raw.bucket) {
      this.logger.warn('Ignoring the `s3` configuration: no `bucket` is set, so S3 cannot be used.');
      return;
    }
    // `enabled: false` disables, exactly as everywhere else in the config (see
    // .claude/rules/configurable-features.md). Reading any object as "enabled" made this the one
    // knob where the documented pre-configuration idiom silently turned a feature ON — and it is a
    // feature that hands out session-less bearer URLs.
    const rawPresigned = raw.presignedDownloads;
    const presigned =
      rawPresigned && typeof rawPresigned === 'object' && (rawPresigned as { enabled?: boolean }).enabled === false
        ? undefined
        : rawPresigned;
    this.config = {
      accessKeyId: raw.accessKeyId,
      autoCreateBucket: raw.autoCreateBucket ?? false,
      bucket: raw.bucket,
      endpoint: raw.endpoint,
      forcePathStyle: raw.forcePathStyle ?? false,
      presignedDownloads: presigned
        ? {
            expiresInSeconds: this.clampPresignedExpiry(
              (typeof presigned === 'object' ? presigned.expiresInSeconds : undefined) ?? 300,
            ),
          }
        : undefined,
      region: raw.region ?? 'us-east-1',
      secretAccessKey: raw.secretAccessKey,
      stagingBucket: raw.stagingBucket ?? raw.bucket,
    };
  }

  /**
   * Bring `s3.presignedDownloads.expiresInSeconds` into a defensible range, once at boot.
   *
   * Clamped here rather than per request so the effective value is what `getConfig()` reports and
   * the warning is emitted once instead of on every download.
   */
  protected clampPresignedExpiry(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      this.logger.warn(
        `s3.presignedDownloads.expiresInSeconds is "${seconds}", which is not a positive number — using 300s.`,
      );
      return 300;
    }
    if (seconds > MAX_PRESIGNED_EXPIRY_SECONDS) {
      this.logger.warn(
        `s3.presignedDownloads.expiresInSeconds is ${seconds}s, above the ${MAX_PRESIGNED_EXPIRY_SECONDS}s AWS SigV4 ` +
          'maximum — capping it, since a longer signature is rejected by S3 rather than honored.',
      );
      return MAX_PRESIGNED_EXPIRY_SECONDS;
    }
    if (seconds > PRESIGNED_EXPIRY_ADVISORY_SECONDS) {
      this.logger.warn(
        `s3.presignedDownloads.expiresInSeconds is ${seconds}s. A presigned URL is an unrevocable bearer capability ` +
          'authorized once at issue time — keep it just long enough for the download to start (a few minutes), not ' +
          'long enough for the link to be forwarded, logged and reused.',
      );
    }
    return seconds;
  }

  /**
   * Whether S3 is configured and enabled
   */
  get enabled(): boolean {
    return !!this.config;
  }

  /**
   * Normalized S3 configuration, or undefined when disabled
   */
  getConfig(): NormalizedS3Config | undefined {
    return this.config;
  }

  /**
   * Lazy-import the AWS SDK and create the shared client.
   * No-op when S3 is not enabled.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config) {
      return;
    }
    try {
      this.sdk = await import('@aws-sdk/client-s3');
    } catch {
      throw new Error(
        'S3 is configured (ServerOptions.s3) but the optional peer dependency "@aws-sdk/client-s3" is not installed. ' +
          'Run: pnpm add @aws-sdk/client-s3',
      );
    }
    const { accessKeyId, endpoint, forcePathStyle, region, secretAccessKey } = this.config;
    this.client = new this.sdk.S3Client({
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle,
      region,
      // Fall back to the SDK default credential chain when no keys are configured
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });

    // Resolved at boot rather than on the first upload, so a missing optional peer is reported
    // where operators look — the startup log — instead of during the first large upload.
    await this.loadMultipartUploader();

    await this.verifyBuckets();
  }

  /**
   * Check at boot that the configured buckets are reachable.
   *
   * Without this the first upload is the first time anyone finds out, and it surfaces as a bare
   * `500 Internal Server Error` with `NoSuchBucket` buried in the server log — a configuration
   * mistake reported as a server fault, at the worst possible moment.
   *
   * It logs rather than throws: S3 may be provisioned moments after the app, and an object store
   * that is briefly unreachable should not stop a server whose other routes work fine.
   * `autoCreateBucket` creates what is missing instead, which is what a self-hosted MinIO/RustFS
   * or a local dev stack usually wants — production buckets normally come from infrastructure code
   * and their credentials often carry no `CreateBucket` permission, hence the default of `false`.
   */
  protected async verifyBuckets(): Promise<void> {
    const buckets = [...new Set([this.config.bucket, this.config.stagingBucket])];
    for (const bucket of buckets) {
      try {
        if (await this.bucketExists(bucket)) {
          continue;
        }
        if (this.config.autoCreateBucket) {
          await this.ensureBucket(bucket);
          this.logger.log(`Created S3 bucket "${bucket}" (s3.autoCreateBucket is on)`);
          continue;
        }
        this.logger.error(
          `S3 bucket "${bucket}" does not exist. Every upload will fail until it is created. ` +
            'Create it in your object storage, or set s3.autoCreateBucket: true to have the server create it.',
        );
      } catch (error) {
        this.logger.error(
          `Could not verify S3 bucket "${bucket}": ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * Whether a bucket exists, without treating "missing" as an error
   */
  protected async bucketExists(bucket: string): Promise<boolean> {
    const { client, sdk } = this.requireInit();
    try {
      await client.send(new sdk.HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch (error: any) {
      const status = error?.$metadata?.httpStatusCode;
      if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchBucket') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Shared S3 client.
   * Throws when S3 is not enabled or the module has not been initialized yet.
   */
  getClient(): S3Client {
    if (!this.config) {
      throw new Error('S3 is not configured/enabled (ServerOptions.s3)');
    }
    if (!this.client || !this.sdk) {
      throw new Error('CoreS3Service is not initialized yet (onModuleInit pending)');
    }
    return this.client;
  }

  /**
   * Upload an object to the main bucket.
   *
   * A `PutObject` needs the body's length: without `Content-Length` the SDK switches to
   * aws-chunked encoding and then fails on a missing `x-amz-decoded-content-length`. So pass
   * `contentLength` whenever the size is known — that streams the body straight through as a
   * single request.
   *
   * A stream of UNKNOWN length goes through a multipart upload instead (`@aws-sdk/lib-storage`),
   * which is what that package exists for: it reads the stream in parts and needs no total up
   * front. It used to be read into memory instead, which made the memory cost of an upload equal
   * to its size — a multi-GB object then either threw "Array buffer allocation failed" or got the
   * container OOM-killed at 100 % progress, taking every other in-flight request with it. That is
   * not a hypothetical shape: any streamed HTTP upload has it, because a multipart request's
   * `Content-Length` covers the whole envelope and therefore cannot be used as the object length.
   *
   * A KNOWN length above {@link CoreS3Service.MAX_SINGLE_PUT_BYTES} goes through the multipart
   * upload as well: AWS S3 refuses a single PutObject that large with `EntityTooLarge`, which for a
   * finished TUS upload means after the client has sent every byte.
   *
   * Without the optional peer dependency both cases behave exactly as before: an unknown length is
   * read into memory, a known one goes up as one PutObject whatever its size (MinIO and RustFS
   * accept that; AWS S3 does not above 5 GiB).
   */
  async putObject(
    key: string,
    body: Buffer | Readable | string,
    contentType?: string,
    contentLength?: number,
  ): Promise<void> {
    const { client, config, sdk } = this.requireInit();

    let payload: Buffer | Readable | string = body;
    let length = contentLength;
    // Multipart for a stream of UNKNOWN length — nothing else carries it without buffering — and for
    // one whose known length exceeds what S3 accepts in a single request.
    if (this.isStream(body) && (length === undefined || length > CoreS3Service.MAX_SINGLE_PUT_BYTES)) {
      const uploader = await this.loadMultipartUploader();
      if (uploader) {
        await this.putObjectMultipart(uploader, key, body, contentType, length);
        return;
      }
    }
    if (this.isStream(body) && length === undefined) {
      payload = await this.collect(body);
      length = payload.length;
    } else if (length === undefined && typeof body !== 'string') {
      length = (body as Buffer).length;
    }

    const send = () =>
      client.send(
        new sdk.PutObjectCommand({
          Body: payload,
          Bucket: config.bucket,
          ...(contentType ? { ContentType: contentType } : {}),
          ...(length === undefined ? {} : { ContentLength: length }),
          Key: key,
        }),
      );

    // A stream handed straight to the SDK is the ONE body shape whose failure is not already
    // ours: the unknown-length branch above reads the stream itself (`for await` throws), and a
    // Buffer cannot fail. See `guardBodyStream` for what goes wrong without this.
    if (this.isStream(payload)) {
      const guard = this.guardBodyStream(payload);
      payload = guard.body;
      try {
        await send();
      } catch (error) {
        throw guard.sourceError() ?? error;
      }
      // A source that died after the SDK already considered the request done would otherwise be
      // reported as a successful upload of a truncated object.
      const failure = guard.sourceError();
      if (failure) {
        throw failure;
      }
      return;
    }
    await send();
  }

  /**
   * The multipart uploader, or `undefined` when the optional peer dependency is absent.
   *
   * Absence is NOT an error here, unlike the missing `@aws-sdk/client-s3` in `onModuleInit`:
   * multipart is an optimisation of a path that already works by buffering, so a project that
   * never installs it keeps the previous behaviour instead of failing to boot. The cost of that
   * choice is memory, which is why the caller's doc states it.
   */
  protected async loadMultipartUploader(): Promise<typeof import('@aws-sdk/lib-storage') | undefined> {
    if (this.multipartUploader !== undefined) {
      return this.multipartUploader ?? undefined;
    }
    try {
      this.multipartUploader = await import('@aws-sdk/lib-storage');
    } catch {
      // `null`, not `undefined`: the field doubles as the "already tried" marker, and a failed
      // import must not be retried on every upload.
      this.multipartUploader = null;
      this.logger.warn(
        'Streaming an S3 upload of unknown length falls back to buffering it in memory because the ' +
          'optional peer dependency "@aws-sdk/lib-storage" is not installed. Run: pnpm add @aws-sdk/lib-storage',
      );
    }
    return this.multipartUploader ?? undefined;
  }

  /**
   * Upload a stream of unknown length as a multipart upload.
   *
   * Memory stays bounded by the uploader's defaults — parts of 5 MiB, at most four in flight —
   * whatever the object's size. A stream that ends within the first part is sent as one ordinary
   * PutObject by `Upload` itself, so a small file costs no multipart round trips.
   *
   * No `guardBodyStream` here, and that is deliberate: the guard exists because the SDK pipes a
   * `PutObject` body into its request without listening for the source's `error`, so a failed
   * source surfaces as a successful upload of a truncated object. `Upload` does listen — a source
   * error rejects `done()` and the already-uploaded parts are aborted — so wrapping it would add a
   * second error path without adding a guarantee.
   */
  protected async putObjectMultipart(
    uploader: typeof import('@aws-sdk/lib-storage'),
    key: string,
    body: Readable,
    contentType?: string,
    contentLength?: number,
  ): Promise<void> {
    const { client, config } = this.requireInit();
    const upload = new uploader.Upload({
      client,
      params: {
        Body: body,
        Bucket: config.bucket,
        // A known total lets `Upload` size its parts (`ceil(total / 10 000)`, at least 5 MiB) so the
        // 10 000-part limit holds, and refuse a stream that yields a different NUMBER of parts than
        // that total implies (it checks the part count, not the byte count). Not sent per part.
        ...(contentLength === undefined ? {} : { ContentLength: contentLength }),
        ...(contentType ? { ContentType: contentType } : {}),
        Key: key,
      },
    });
    await upload.done();
  }

  /**
   * Shield the SDK from a REQUEST-BODY stream that can fail, and keep the cause.
   *
   * WHY THIS EXISTS: the AWS SDK pipes the body into its HTTP request without listening on the
   * SOURCE. An error there therefore reached a stream with NO listener, and Node turns an unhandled
   * `'error'` event into an uncaught exception that ends the process. Reachable from ordinary
   * operation — this is the path a tus upload takes when it is migrated into S3 (`body` plus a
   * known `contentLength`), so a staged read that drops mid-migration took the API down with it.
   * It is also a driver asymmetry of the shape this release keeps finding: the filesystem driver
   * routes the same stream through `pipeline()`, which forwards both ends, and GridFS has its own
   * source handler. Only S3 had none.
   *
   * WHY A RELAY RATHER THAN JUST A LISTENER: a listener alone stops the uncaught exception, but the
   * SDK's own request pipeline still observes a body stream that ERRORED and rejects a promise of
   * its own that nothing awaits — an unhandled rejection, which Node also treats as fatal by
   * default. So the SDK must never see a failing stream at all. It gets a `PassThrough` that simply
   * ENDS early instead; short of its declared `Content-Length`, that is an ordinary request failure
   * the SDK reports through the promise we are already awaiting. `sourceError()` then replaces the
   * SDK's `socket hang up` with the actual cause, which is the part an operator needs.
   *
   * A `Promise.race` against the send would be the obvious alternative and is worse: it introduces
   * a second promise for the same failure, and whichever loses the race is a rejection nobody
   * consumes — trading the uncaught exception for exactly the unhandled rejection above.
   */
  protected guardBodyStream(stream: Readable): { body: Readable; sourceError: () => Error | undefined } {
    const relay = new PassThrough();
    let sourceError: Error | undefined;

    stream.on('error', (error: Error) => {
      sourceError = error;
      // GRACEFUL end, never `destroy(error)`: propagating the error into the relay would hand the
      // SDK the failing stream this method exists to keep away from it.
      relay.end();
    });
    stream.pipe(relay);

    return { body: relay, sourceError: () => sourceError };
  }

  /**
   * Copy an object into the main bucket WITHOUT the bytes passing through this process.
   *
   * S3 does the transfer internally, so the call costs one request instead of a full GET plus a
   * full PUT held open for the duration. That difference is the whole point: the streaming
   * alternative pins a request handler (and any lock it holds) for as long as the object takes to
   * travel down to the pod and back up again — at the framework's 50 GB upload cap that is
   * unbounded, and even a few GB overruns a typical reverse-proxy read timeout while doubling
   * billable S3 traffic.
   *
   * `sourceBucket` defaults to the main bucket; pass it for a cross-bucket copy (the TUS staging
   * bucket may differ from the file bucket). Both buckets must live behind THIS service's endpoint
   * and credentials — S3 cannot copy from a store it cannot itself reach.
   *
   * **5 GB limit.** A single `CopyObject` cannot move more than 5 GB; larger objects require
   * multipart upload-part-copy. Callers must check the size first — see
   * {@link CoreS3Service.MAX_COPY_OBJECT_BYTES} — and fall back to streaming, loudly.
   */
  async copyObject(sourceKey: string, destinationKey: string, sourceBucket?: string, contentType?: string) {
    const { client, config, sdk } = this.requireInit();
    await client.send(
      new sdk.CopyObjectCommand({
        Bucket: config.bucket,
        // `<bucket>/<key>`, URL-encoded per path segment: an unencoded key containing a space or a
        // `+` is a signature mismatch rather than a missing object, which is far harder to read.
        CopySource: this.copySource(sourceBucket ?? config.bucket, sourceKey),
        Key: destinationKey,
        // Without REPLACE the copy inherits the SOURCE object's content type. A TUS staging object
        // carries none, so every copied file would download as application/octet-stream.
        ...(contentType ? { ContentType: contentType, MetadataDirective: 'REPLACE' as const } : {}),
      }),
    );
  }

  /**
   * Largest object a single `CopyObject` can move (S3 hard limit).
   * Above this AWS requires multipart upload-part-copy.
   */
  static readonly MAX_COPY_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;

  /**
   * Largest object a single `PutObject` can carry (AWS S3 hard limit). {@link CoreS3Service.putObject}
   * sends a known length above it as a multipart upload instead.
   */
  static readonly MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;

  /**
   * Build the `CopySource` value for {@link CoreS3Service.copyObject}
   */
  protected copySource(bucket: string, key: string): string {
    const encoded = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `/${encodeURIComponent(bucket)}/${encoded}`;
  }

  /**
   * Whether the value is a readable stream rather than a Buffer or string
   */
  protected isStream(body: unknown): body is Readable {
    return !!body && typeof (body as Readable).pipe === 'function';
  }

  /**
   * Read a stream fully into memory (only for a body whose length is not known upfront)
   */
  protected async collect(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Get an object stream (plus metadata) from the main bucket.
   * Throws the SDK's NoSuchKey error when the object does not exist.
   */
  async getObject(key: string): Promise<{ body: Readable; contentLength?: number; contentType?: string }> {
    const { client, config, sdk } = this.requireInit();
    const result = await client.send(new sdk.GetObjectCommand({ Bucket: config.bucket, Key: key }));
    return {
      body: result.Body as Readable,
      contentLength: result.ContentLength,
      contentType: result.ContentType,
    };
  }

  /**
   * Delete an object (no error when it does not exist).
   * `bucket` defaults to the main bucket; pass it to reach the staging bucket.
   */
  async deleteObject(key: string, bucket?: string): Promise<void> {
    const { client, config, sdk } = this.requireInit();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket ?? config.bucket, Key: key }));
  }

  /**
   * Whether an object exists in the main bucket
   */
  async objectExists(key: string): Promise<boolean> {
    return (await this.statObject(key)) !== null;
  }

  /**
   * Size and content type of an object in the main bucket, or `null` when it does not exist.
   *
   * One HEAD request. This is how the length of an object uploaded WITHOUT a known length is
   * learned afterwards: the stored object is the authority on its own size.
   */
  async statObject(key: string): Promise<null | { contentLength?: number; contentType?: string }> {
    const { client, config, sdk } = this.requireInit();
    try {
      const result = await client.send(new sdk.HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return { contentLength: result.ContentLength, contentType: result.ContentType };
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a presigned download URL for an object in the main bucket.
   * Returns undefined when presigned downloads are not enabled.
   * Requires the optional peer dependency `@aws-sdk/s3-request-presigner`.
   */
  async getPresignedDownloadUrl(key: string, filename?: string): Promise<string | undefined> {
    const { client, config, sdk } = this.requireInit();
    if (!config.presignedDownloads) {
      return undefined;
    }
    if (!this.presigner) {
      try {
        this.presigner = await import('@aws-sdk/s3-request-presigner');
      } catch {
        throw new Error(
          's3.presignedDownloads is enabled but the optional peer dependency "@aws-sdk/s3-request-presigner" is not installed. ' +
            'Run: pnpm add @aws-sdk/s3-request-presigner',
        );
      }
    }
    const command = new sdk.GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      // Same renderer as the streamed branch in CoreFileController. S3 echoes this back verbatim
      // as the response header, so a hand-rolled value here means one file downloads under two
      // different names depending on whether presigned downloads happen to be enabled — which is
      // invisible until someone compares the two. It also has to be a real RFC 6266 value: the
      // quoted `filename` is never percent-decoded (so encoding it saves `Übersicht%20.pdf`
      // literally), and without `filename*` a non-ASCII name is lost outright.
      ...(filename ? { ResponseContentDisposition: buildContentDisposition(filename) } : {}),
    });
    return this.presigner.getSignedUrl(client, command, { expiresIn: config.presignedDownloads.expiresInSeconds });
  }

  /**
   * Ensure a bucket exists (used by tests and first-boot convenience for
   * self-hosted S3 like MinIO/RustFS — AWS buckets are usually pre-provisioned)
   */
  async ensureBucket(bucket: string): Promise<void> {
    const { client, sdk } = this.requireInit();
    try {
      await client.send(new sdk.HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
    }
  }

  /**
   * Destroy the shared client
   */
  async onApplicationShutdown(): Promise<void> {
    this.client?.destroy();
    this.client = undefined;
  }

  /**
   * Narrowing guard: config + client + sdk are all present after onModuleInit
   */
  protected requireInit(): { client: S3Client; config: NormalizedS3Config; sdk: typeof import('@aws-sdk/client-s3') } {
    if (!this.config) {
      throw new Error('S3 is not configured/enabled (ServerOptions.s3)');
    }
    if (!this.client || !this.sdk) {
      throw new Error('CoreS3Service is not initialized yet (onModuleInit pending)');
    }
    return { client: this.client, config: this.config, sdk: this.sdk };
  }
}
