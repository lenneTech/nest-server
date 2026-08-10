import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

import { ConfigService } from './config.service';

import type { IS3Config } from '../interfaces/server-options.interface';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

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
    const presigned = raw.presignedDownloads;
    this.config = {
      accessKeyId: raw.accessKeyId,
      autoCreateBucket: raw.autoCreateBucket ?? false,
      bucket: raw.bucket,
      endpoint: raw.endpoint,
      forcePathStyle: raw.forcePathStyle ?? false,
      presignedDownloads: presigned
        ? { expiresInSeconds: (typeof presigned === 'object' ? presigned.expiresInSeconds : undefined) ?? 300 }
        : undefined,
      region: raw.region ?? 'us-east-1',
      secretAccessKey: raw.secretAccessKey,
      stagingBucket: raw.stagingBucket ?? raw.bucket,
    };
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
   * A stream needs its length: without `Content-Length` the SDK switches to aws-chunked
   * encoding and then fails on a missing `x-amz-decoded-content-length`, so a stream of
   * unknown size is read into memory first. Pass `contentLength` whenever the size is
   * known — that streams the body straight through instead of buffering it.
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
    if (this.isStream(body) && length === undefined) {
      payload = await this.collect(body);
      length = payload.length;
    } else if (length === undefined && typeof body !== 'string') {
      length = (body as Buffer).length;
    }

    await client.send(
      new sdk.PutObjectCommand({
        Body: payload,
        Bucket: config.bucket,
        ...(contentType ? { ContentType: contentType } : {}),
        ...(length === undefined ? {} : { ContentLength: length }),
        Key: key,
      }),
    );
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
   * Delete an object from the main bucket (no error when it does not exist)
   */
  async deleteObject(key: string): Promise<void> {
    const { client, config, sdk } = this.requireInit();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  }

  /**
   * Whether an object exists in the main bucket
   */
  async objectExists(key: string): Promise<boolean> {
    const { client, config, sdk } = this.requireInit();
    try {
      await client.send(new sdk.HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return true;
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
        return false;
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
    let presigner: typeof import('@aws-sdk/s3-request-presigner');
    try {
      presigner = await import('@aws-sdk/s3-request-presigner');
    } catch {
      throw new Error(
        's3.presignedDownloads is enabled but the optional peer dependency "@aws-sdk/s3-request-presigner" is not installed. ' +
          'Run: pnpm add @aws-sdk/s3-request-presigner',
      );
    }
    const command = new sdk.GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ...(filename ? { ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"` } : {}),
    });
    return presigner.getSignedUrl(client, command, { expiresIn: config.presignedDownloads.expiresInSeconds });
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
