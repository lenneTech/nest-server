import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FileStore } from '@tus/file-store';
import { Server, Upload } from '@tus/server';
import * as fs from 'fs';
import { Connection, mongo } from 'mongoose';
import * as path from 'path';
import { Readable } from 'stream';

import { GridFSHelper } from '../../common/helpers/gridfs.helper';
import { ITusConfig } from '../../common/interfaces/server-options.interface';
import { buildCorsConfig } from '../../common/helpers/cookies.helper';
import { ConfigService } from '../../common/services/config.service';
import { CoreRedisService } from '../../common/services/core-redis.service';
import { CoreS3Service } from '../../common/services/core-s3.service';
import { getTenantContextResolver } from '../../common/services/core-tenant-context.registry';
import { resolveFileStorage } from '../file/file-storage.helper';
import {
  DEFAULT_FILESYSTEM_DIR,
  FILESYSTEM_FILES_COLLECTION,
  FilesystemFileHelper,
} from '../file/filesystem-file.helper';
import { S3_FILES_COLLECTION, S3FileHelper } from '../file/s3-file.helper';
import { TUS_OWNER_METADATA_KEY, TUS_TENANT_METADATA_KEY } from './tus.constants';
import { TusRedisLocker } from './tus-redis-locker';
import {
  DEFAULT_TUS_ALLOWED_HEADERS,
  DEFAULT_TUS_CONFIG,
  normalizeTusConfig,
  parseExpirationTime,
} from './interfaces/tus-config.interface';

/**
 * Optional dependencies of CoreTusService.
 *
 * With an enabled CoreS3Service, in-progress uploads are staged in the S3
 * staging bucket instead of on local disk (`tus.s3Staging`), which keeps
 * resumable uploads working across replica restarts.
 */
export interface CoreTusServiceOptions {
  configService?: ConfigService;

  /**
   * How a subclass reaches project providers. `TusModule` constructs the service itself, with
   * exactly `(connection, options)`, so a subclass cannot declare constructor dependencies of its
   * own — resolve them at call time instead:
   * `this.options?.moduleRef?.get(QuotaService, { strict: false })`.
   */
  moduleRef?: ModuleRef;

  /** Central Redis; when present, upload locks are shared across replicas */
  redisService?: CoreRedisService;

  s3Service?: CoreS3Service;
}

/** Marks a response whose `end()` was already normalised (see `normalizeEndCallback()`). */
const END_CALLBACK_NORMALIZED = Symbol('tusEndCallbackNormalized');

/**
 * Core TUS Service
 *
 * Provides integration with @tus/server for resumable file uploads.
 * After upload completion, files are migrated to the configured file storage
 * (S3 when `file.storage: 's3'`, otherwise GridFS).
 *
 * Uploads in progress are staged either on local disk (`@tus/file-store`) or,
 * when S3 is configured and `tus.s3Staging` is not disabled, in the S3 staging
 * bucket (`@tus/s3-store`). When BOTH ends are that same S3 store, the finished
 * upload is moved by S3 itself (`CopyObject`) instead of being streamed through
 * this process — see `canCopyWithinS3()`.
 *
 * NOTE: give the staging bucket a lifecycle rule that expires incomplete
 * multipart uploads — aborted TUS uploads leave parts behind that nothing else
 * cleans up (the local-disk store is swept by the expiration cleanup below).
 * Objects of COMPLETED uploads are not covered by such a rule and are removed
 * explicitly instead — see `deleteStagedObjects()`.
 *
 * This service follows the Module Inheritance Pattern and can be extended in projects.
 */
@Injectable()
export class CoreTusService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(CoreTusService.name);
  private tusServer: null | Server = null;
  private config: ITusConfig;
  private files: mongo.GridFSBucket;
  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Datastore of the TUS server; set when uploads are staged in S3 */
  protected s3Store: any = null;

  /**
   * Whether {@link CoreTusService.s3Store} was built from `options.s3Service`.
   *
   * Only then do staging and final storage share one endpoint, one region and one set of
   * credentials — the precondition for letting S3 copy the finished upload internally. Tracked
   * as a flag rather than inferred from `s3Store` being set, because a subclass may override
   * {@link CoreTusService.createS3Store} to stage somewhere else entirely.
   */
  protected s3StoreSharesEndpoint = false;

  constructor(
    private readonly connection: Connection,
    protected readonly options?: CoreTusServiceOptions,
  ) {
    // Initialize with defaults - will be configured in onModuleInit or via configure()
    this.config = { ...DEFAULT_TUS_CONFIG };
  }

  /**
   * Configure the TUS service
   * Called by TusModule.forRoot() with the resolved configuration
   */
  configure(config: boolean | ITusConfig | undefined): void {
    // A disabled configuration must reach onModuleInit() as disabled. Keeping the defaults here
    // started a tus server — upload directory, hourly cleanup interval — behind a module that
    // registers no endpoint at all.
    this.config = normalizeTusConfig(config) ?? { ...DEFAULT_TUS_CONFIG, enabled: false };
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.debug('TUS uploads disabled');
      return;
    }

    // Idempotent on purpose: a second init would replace `tusServer` and `cleanupInterval`, and
    // the replaced interval — no longer referenced — could never be cleared again.
    if (this.tusServer) {
      return;
    }

    // Initialize GridFS bucket
    this.files = new mongo.GridFSBucket(this.connection.db, { bucketName: 'fs' });

    // Ensure upload directory exists
    const uploadDir = this.config.uploadDir || DEFAULT_TUS_CONFIG.uploadDir;
    await this.ensureUploadDir(uploadDir);

    // Create TUS server instance
    this.tusServer = await this.createTusServer(uploadDir);

    // Setup expiration cleanup if enabled
    this.setupExpirationCleanup();

    this.logger.log(`TUS server initialized at ${this.config.path}`);
    this.logEnabledFeatures();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get the TUS server instance
   */
  getServer(): null | Server {
    return this.tusServer;
  }

  /**
   * Get the current configuration
   */
  getConfig(): ITusConfig {
    return this.config;
  }

  /**
   * Check if TUS is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled !== false && this.tusServer !== null;
  }

  /**
   * Get the configured path
   */
  getPath(): string {
    return this.config.path || DEFAULT_TUS_CONFIG.path;
  }

  /**
   * Handle upload completion - migrate to GridFS
   *
   * This method can be overridden in extending services to customize
   * what happens after an upload completes.
   */
  protected async onUploadComplete(upload: Upload): Promise<void> {
    try {
      // Extract metadata
      const metadata = this.parseMetadata(upload.metadata);
      const filename = metadata.filename || upload.id;
      const contentType = metadata.filetype || 'application/octet-stream';
      const fileMetadata = {
        originalMetadata: metadata,
        // The key `CoreFileService.checkRights()` documents for a per-file ownership rule. Without it
        // a tus-uploaded file could never satisfy that rule — it failed CLOSED for everyone but
        // ADMIN, so a project following the documented pattern ended up with undownloadable files.
        // Written from the SERVER-recorded owner, never from the client's own metadata.
        ...(metadata[TUS_OWNER_METADATA_KEY] ? { ownerId: metadata[TUS_OWNER_METADATA_KEY] } : {}),
        // The tenant the upload was created in — validated against an active membership in
        // onUploadCreate(), never taken from the client. Present only with multi-tenancy active; it
        // is what the file module's `'tenant'` access preset decides on.
        ...(metadata[TUS_TENANT_METADATA_KEY] ? { tenantId: metadata[TUS_TENANT_METADATA_KEY] } : {}),
        tusUploadId: upload.id,
        uploadedAt: new Date(),
      };

      // S3 → S3: hand the object over INSIDE S3 rather than pulling it down and pushing it back
      // up. The streaming path below is correct but pins the finishing PATCH request — and the
      // upload lock it holds — for a full download plus a full upload of the whole file. At the
      // 50 GB default cap that is unbounded; even a few GB overruns a typical reverse-proxy read
      // timeout, and it pays for the traffic twice.
      if (this.canCopyWithinS3(upload)) {
        const fileInfo = await S3FileHelper.copyFile(
          this.options.s3Service,
          this.connection.db.collection(S3_FILES_COLLECTION),
          {
            contentLength: upload.size,
            contentType,
            filename,
            metadata: fileMetadata,
            sourceBucket: this.options.s3Service.getConfig().stagingBucket,
            sourceKey: upload.id,
          },
        );
        this.logger.debug(
          `Upload ${upload.id} copied inside S3 to ${fileInfo._id} (filename: ${filename}) — no bytes through this process`,
        );
        await this.deleteStagedUpload(upload.id);
        return;
      }

      const readStream = await this.readStagedUpload(upload.id);
      if (!readStream) {
        return;
      }

      if (this.fileStorageDriver === 'filesystem') {
        const fileInfo = await FilesystemFileHelper.writeFile(
          this.fileStorageDir,
          this.connection.db.collection(FILESYSTEM_FILES_COLLECTION),
          { body: readStream, contentType, filename, metadata: fileMetadata },
        );
        this.logger.debug(`Upload ${upload.id} migrated to the filesystem as ${fileInfo._id} (filename: ${filename})`);
      } else if (this.s3FileStorage) {
        const fileInfo = await S3FileHelper.writeFile(
          this.options.s3Service,
          this.connection.db.collection(S3_FILES_COLLECTION),
          // Streamed with the length TUS already knows, so a multi-GB resumable upload is never
          // materialised in memory.
          { body: readStream, contentLength: upload.size, contentType, filename, metadata: fileMetadata },
        );
        this.logger.debug(`Upload ${upload.id} migrated to S3 as ${fileInfo._id} (filename: ${filename})`);
      } else {
        const fileInfo = await GridFSHelper.writeFileFromStream(this.files, readStream, {
          contentType,
          filename,
          metadata: fileMetadata,
        });
        this.logger.debug(`Upload ${upload.id} migrated to GridFS as ${fileInfo._id} (filename: ${filename})`);
      }

      // Clean up the staged upload
      await this.deleteStagedUpload(upload.id);
    } catch (error) {
      this.logger.error(`Failed to migrate upload ${upload.id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Which store a finished upload is migrated into.
   *
   * Deliberately the SAME resolution `CoreFileService` uses. A tus upload has to
   * land where the download routes look for it — resolving this independently is
   * how an upload ends up written to one store and read from another.
   */
  protected get fileStorageDriver(): string {
    return resolveFileStorage(ConfigService.configFastButReadOnly).driver;
  }

  /** Directory used when uploads are migrated to the local filesystem */
  protected get fileStorageDir(): string {
    return ConfigService.configFastButReadOnly?.file?.storageDir || DEFAULT_FILESYSTEM_DIR;
  }

  /**
   * Whether finished uploads are stored in S3 (`file.storage: 's3'`) instead of GridFS
   */
  protected get s3FileStorage(): boolean {
    return !!this.options?.s3Service?.enabled && this.fileStorageDriver === 's3';
  }

  /**
   * Whether the finished upload can be handed over inside S3 (server-side copy) instead of
   * streaming through this process.
   *
   * Requires BOTH ends to be the same S3 store: staged by `createS3Store()` from
   * `options.s3Service`, and a final driver of `'s3'` backed by that same service. Every other
   * combination — S3 staging → GridFS, S3 staging → filesystem, local-disk staging → anything —
   * genuinely has to transit the pod, because no store can reach into the other.
   */
  protected canCopyWithinS3(upload: Upload): boolean {
    if (!this.s3StoreSharesEndpoint || !this.s3FileStorage) {
      return false;
    }

    // A single CopyObject cannot move more than 5 GB; above that S3 requires multipart
    // upload-part-copy. We fall back to streaming rather than implement that — but never
    // silently: this is exactly the size at which the streaming cost the copy avoids becomes
    // severe, so an operator seeing slow, timing-out completions needs to find the reason in
    // the log rather than guess at it.
    if (typeof upload.size !== 'number') {
      this.logger.warn(
        `Upload ${upload.id} has no known size, so it cannot be size-checked against the ${CoreS3Service.MAX_COPY_OBJECT_BYTES}-byte ` +
          'CopyObject limit — streaming it through this process instead.',
      );
      return false;
    }
    if (upload.size > CoreS3Service.MAX_COPY_OBJECT_BYTES) {
      this.logger.warn(
        `Upload ${upload.id} is ${upload.size} bytes, above the ${CoreS3Service.MAX_COPY_OBJECT_BYTES}-byte limit of a single ` +
          'S3 CopyObject (multipart upload-part-copy would be required). Streaming it through this process instead — ' +
          'expect the finishing request to run for the duration of a full download plus a full upload.',
      );
      return false;
    }

    return true;
  }

  /**
   * Locker for upload exclusivity, or undefined to keep @tus/server's in-process default.
   */
  protected createLocker(): any {
    const redisService = this.options?.redisService;
    if (!redisService?.enabled) {
      return undefined;
    }
    this.logger.debug('TUS upload locks are shared via Redis');
    return new TusRedisLocker(redisService);
  }

  /**
   * Import the optional peer dependency `@tus/s3-store`.
   * Separate method so tests can substitute the module.
   */
  protected importS3Store(): Promise<any> {
    return import('@tus/s3-store');
  }

  /**
   * Create the S3 staging datastore.
   * Returns null when S3 staging is not available, so the caller falls back to the local FileStore.
   */
  protected async createS3Store(): Promise<any> {
    const s3Service = this.options?.s3Service;
    if (!s3Service?.enabled || this.config.s3Staging === false) {
      return null;
    }

    let s3StoreModule: any;
    try {
      s3StoreModule = await this.importS3Store();
    } catch {
      this.logger.warn(
        'S3 is configured but the optional peer dependency "@tus/s3-store" is not installed — TUS uploads are ' +
          'staged on local disk. Run: pnpm add @tus/s3-store',
      );
      return null;
    }

    const { accessKeyId, endpoint, forcePathStyle, region, secretAccessKey, stagingBucket } = s3Service.getConfig();
    this.s3Store = new s3StoreModule.S3Store({
      s3ClientConfig: {
        bucket: stagingBucket,
        forcePathStyle,
        region,
        ...(endpoint ? { endpoint } : {}),
        ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      },
    });
    // Built from the shared CoreS3Service, so a finished upload can be copied inside S3.
    this.s3StoreSharesEndpoint = true;
    this.logger.log(`TUS uploads staged in S3 bucket ${stagingBucket}`);
    return this.s3Store;
  }

  /**
   * Read a completed upload from its staging location (S3 or local disk).
   * Returns null when the staged data is gone.
   */
  protected async readStagedUpload(uploadId: string): Promise<null | Readable> {
    if (this.s3Store) {
      return await this.s3Store.read(uploadId);
    }

    const uploadDir = this.config.uploadDir || DEFAULT_TUS_CONFIG.uploadDir;
    const filePath = path.join(uploadDir, uploadId);
    const fileExists = await fs.promises
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (!fileExists) {
      this.logger.warn(`Upload file not found at ${filePath}, skipping migration`);
      return null;
    }
    return fs.createReadStream(filePath);
  }

  /**
   * Delete a staged upload from its staging location (S3 or local disk)
   */
  protected async deleteStagedUpload(uploadId: string): Promise<void> {
    if (this.s3Store) {
      try {
        // Still worth calling: for an upload that never finished, this aborts the multipart and
        // frees the uploaded parts, which a DeleteObject cannot do.
        await this.s3Store.remove(uploadId);
      } catch (error) {
        // `remove()` issues AbortMultipartUpload FIRST, and for a COMPLETED upload S3 answers
        // NoSuchUpload. @tus/s3-store v2 swallows that by testing `error.code` — an AWS SDK v2
        // field that SDK v3 never populates (v3 uses `error.name` / `$metadata.httpStatusCode`) —
        // so the error escapes and the deletion that follows it never runs. Every finished upload
        // therefore left a full second copy of the file behind, in a bucket that by default IS the
        // file bucket. No lifecycle rule reaches those: they are completed objects, not incomplete
        // multiparts. Hence the explicit cleanup below, which does not depend on the peer's guard.
        if (!this.isMissingUploadError(error)) {
          this.logger.warn(`Failed to remove staged upload ${uploadId} from S3: ${error.message}`);
        }
      }
      await this.deleteStagedObjects(uploadId);
      return;
    }
    await this.deleteTemporaryFile(uploadId);
  }

  /**
   * Delete the staged object and its `.info` sidecar from the staging bucket.
   *
   * Unconditional and idempotent: when `S3Store.remove()` already got there, these are no-ops
   * (S3 answers a successful delete for a key that does not exist), and when it did not, this is
   * what actually reclaims the space.
   */
  protected async deleteStagedObjects(uploadId: string): Promise<void> {
    const s3Service = this.options?.s3Service;
    // Only when the staging store is OURS — a subclass may stage somewhere this service cannot see.
    if (!this.s3StoreSharesEndpoint || !s3Service?.enabled) {
      return;
    }
    const { stagingBucket } = s3Service.getConfig();
    for (const key of [uploadId, `${uploadId}.info`]) {
      try {
        await s3Service.deleteObject(key, stagingBucket);
      } catch (error) {
        this.logger.warn(`Failed to delete staged object ${key} from S3 bucket ${stagingBucket}: ${error.message}`);
      }
    }
  }

  /**
   * Whether an S3 error means "that upload/object is not there" — which, when cleaning up, is the
   * outcome we wanted anyway.
   *
   * Matches on `name` and the HTTP status, never on `code`: that is the AWS SDK v2 shape, and
   * relying on it is exactly the bug this guards against.
   */
  protected isMissingUploadError(error: any): boolean {
    const name = error?.name ?? error?.Code;
    return (
      name === 'NoSuchUpload' || name === 'NoSuchKey' || name === 'NotFound' || error?.$metadata?.httpStatusCode === 404
    );
  }

  /**
   * Handle upload termination (deletion)
   */
  protected async onUploadTerminate(upload: Upload): Promise<void> {
    this.logger.debug(`Upload ${upload.id} terminated`);
    await this.deleteStagedUpload(upload.id);
  }

  /**
   * The authenticated caller's id, as the upstream role guard left it on the request.
   *
   * `CoreTusController.handleTus(req, res)` receives the Express request, so `req.user` is whatever
   * the guard put there. But `@tus/server` v2 does NOT hand that object to its hooks: `handle()`
   * converts the Node request into a WHATWG `ServerRequest` (srvx) first, and anything the guard
   * attached lives on the ORIGINAL request, reachable through `runtime.node.req`. Reading only
   * `req.user` therefore finds nothing and every upload silently becomes owner-less — which fails in
   * the permissive direction, so it would not have shown up as an error anywhere.
   *
   * Returns `undefined` for an unauthenticated request, which is a legitimate state: a project may
   * open the gate with `tus.roles: [RoleEnum.S_EVERYONE]` for a public form.
   *
   * Override to read the owner from somewhere else (an API key, a signed form token).
   */
  protected readRequestUserId(req: any): string | undefined {
    const id = req?.user?.id ?? req?.runtime?.node?.req?.user?.id ?? req?.context?.user?.id;
    return id === undefined || id === null || id === '' ? undefined : String(id);
  }

  /**
   * Refuse a request that names an upload the caller does not own.
   *
   * `tus.roles` is the coarse gate — who may reach the endpoint at all. This is the fine one: HEAD
   * (read the offset), PATCH (APPEND BYTES) and DELETE (terminate) all address an upload by its URL,
   * and without this any authenticated caller who learns an id could resume, overwrite or destroy
   * somebody else's upload. Appending is the sharpest: those bytes are then migrated into the file
   * store under the ORIGINAL uploader's filename, so the attacker's content is served as the victim's.
   *
   * **Refuses with 404, never 403** — the same policy `CoreFileService.checkRights()` states: a
   * refusal must be indistinguishable from an upload that does not exist, or the endpoint becomes an
   * existence oracle for ids that are not secrets.
   *
   * **An OWNER-LESS upload stays reachable by anyone who may reach the endpoint.** That is deliberate
   * and load-bearing for backward compatibility: uploads created before 11.35.0 carry no owner, and
   * so does every upload of a project that deliberately runs the endpoint public. Denying those would
   * turn an upgrade into a fleet-wide breakage of in-flight uploads and break a documented
   * configuration. What is closed is the case that actually leaks: an upload that HAS an owner being
   * touched by somebody else.
   *
   * Override to widen this — e.g. to let a support role resume any upload.
   */
  protected async assertUploadOwnership(req: any, uploadId: string): Promise<void> {
    // No id: this is a creation (POST) or a server-capability request (OPTIONS). Nothing to own yet.
    if (!uploadId) {
      return;
    }

    let owner: string | undefined;
    try {
      const upload = await (this.tusServer as any)?.datastore?.getUpload?.(uploadId);
      const recorded = upload?.metadata?.[TUS_OWNER_METADATA_KEY];
      owner = recorded === undefined || recorded === null ? undefined : String(recorded);
    } catch {
      // Unknown id, or a store that cannot answer right now. Say nothing and let the tus server
      // produce its own 404 — inventing a refusal here would also refuse legitimate retries during a
      // transient store outage.
      return;
    }

    if (!owner) {
      return; // owner-less upload — see the note above
    }

    const caller = this.readRequestUserId(req);
    if (caller && caller === owner) {
      return;
    }

    this.logger.warn(`Refused tus request for upload ${uploadId}: caller is not its owner`);
    throw Object.assign(new Error('Upload not found'), { body: 'Upload not found', status_code: 404 });
  }

  /**
   * The tus extensions the configuration switched off. `@tus/server` consults none of these flags:
   * the store advertises creation and termination whatever is configured, and POST / DELETE are
   * served regardless — so before 11.42.9 `termination: false` was a line in the boot log and nothing
   * else.
   */
  protected disabledExtensions(): Set<string> {
    const disabled = new Set<string>();
    if (this.config.creation === false) {
      ['creation', 'creation-with-upload', 'creation-defer-length'].forEach((extension) => disabled.add(extension));
    }
    if (this.config.creationWithUpload === false) {
      disabled.add('creation-with-upload');
    }
    if (this.config.termination === false) {
      disabled.add('termination');
    }
    return disabled;
  }

  /**
   * Refuses a request that needs an extension the configuration switched off, with the 501 `@tus/server`
   * itself answers for an extension it does not support. Runs before the ownership check, so a
   * refusal says nothing about whether the upload exists.
   */
  protected assertExtensionEnabled(req: any): void {
    const disabled = this.disabledExtensions();
    const method = String(req?.method ?? '').toUpperCase();
    const contentType = this.readRequestHeader(req, 'content-type')?.toLowerCase() ?? '';
    const needed =
      method === 'DELETE'
        ? 'termination'
        : method === 'POST'
          ? contentType.startsWith('application/offset+octet-stream')
            ? 'creation-with-upload'
            : 'creation'
          : undefined;
    if (needed && disabled.has(needed)) {
      throw Object.assign(new Error(`The ${needed} extension is disabled`), {
        body: `The ${needed} extension is disabled\n`,
        status_code: 501,
      });
    }
  }

  /**
   * The path a new upload's URL is built on: the one the creation request arrived at, so the URL
   * points where the controller actually listens — under a global prefix, a URI version or a project's
   * own route alike.
   *
   * Except when the configured `path` is longer and ends with it: then a reverse proxy strips a prefix
   * on the way in (public `/files/tus`, forwarded as `/tus`), and the client must be handed the public
   * path — which is what `path` was set to before 11.42.9 for exactly that reason. Override for a proxy
   * that rewrites the path in any other way.
   */
  protected uploadCollectionPath(req: any): string {
    const configured = (this.config.path || DEFAULT_TUS_CONFIG.path).replace(/\/+$/, '');
    let requested: string;
    try {
      requested = new URL(String(req?.url ?? ''), 'http://localhost').pathname.replace(/\/+$/, '');
    } catch {
      return configured;
    }
    return configured.length > requested.length && configured.endsWith(requested) ? configured : requested;
  }

  /**
   * Validate file type against allowedTypes configuration
   *
   * This method can be overridden in extending services to customize
   * file type validation logic.
   *
   * @param filetype - The MIME type from upload metadata
   * @returns true if allowed, false if rejected
   */
  protected validateFileType(filetype: string | undefined): boolean {
    const allowedTypes = this.config.allowedTypes;

    // If no restrictions configured, allow all types
    if (!allowedTypes || allowedTypes.length === 0) {
      return true;
    }

    // If no filetype provided in metadata, reject when restrictions exist
    if (!filetype) {
      return false;
    }

    // Check exact match
    if (allowedTypes.includes(filetype)) {
      return true;
    }

    // Check wildcard patterns (e.g., 'image/*')
    for (const allowed of allowedTypes) {
      if (allowed.endsWith('/*')) {
        const prefix = allowed.slice(0, -1); // 'image/*' -> 'image/'
        if (filetype.startsWith(prefix)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Runs when a client CREATES an upload — the one point where the declared `Upload-Length` is known
   * and no byte has been written yet. Returning `{ metadata }` is what PERSISTS it: the tus server
   * writes the returned value onto the upload (returning `{}` would keep the client's metadata
   * verbatim). Throw an error carrying `status_code` to refuse the upload.
   *
   * Records two framework-owned keys, both OVERWRITTEN rather than merged, because the client's
   * `Upload-Metadata` header must never be able to set them:
   * - {@link TUS_OWNER_METADATA_KEY} — the authenticated creator (see `assertUploadOwnership()`).
   * - {@link TUS_TENANT_METADATA_KEY} — the validated tenant, only while multi-tenancy is active
   *   (see `resolveUploadTenantId()`); `null` otherwise.
   *
   * Override to add project rules — a quota, a per-tenant type policy — and call `super` to keep the
   * owner, the tenant and `allowedTypes`. Register the subclass via `TusModule.forRoot({ service })`.
   */
  protected async onUploadCreate(req: any, upload: Upload): Promise<{ metadata: Record<string, null | string> }> {
    // Record the creator and the tenant FIRST, so the checks below and later requests have something
    // to compare against.
    const metadata: Record<string, null | string> = {
      ...upload.metadata,
      [TUS_OWNER_METADATA_KEY]: this.readRequestUserId(req) ?? null,
      [TUS_TENANT_METADATA_KEY]: (await this.resolveUploadTenantId(req)) ?? null,
    };

    // Validate file type if allowedTypes is configured
    if (this.config.allowedTypes && this.config.allowedTypes.length > 0) {
      const filetype = this.parseMetadata(upload.metadata).filetype;

      if (!this.validateFileType(filetype)) {
        const allowedList = this.config.allowedTypes.join(', ');
        this.logger.warn(
          `Upload rejected: file type '${filetype || 'unknown'}' not allowed. Allowed types: ${allowedList}`,
        );

        // Throw error to reject the upload
        // @tus/server v2 expects throwing an error with status_code
        const error = new Error(`File type '${filetype || 'unknown'}' is not allowed. Allowed types: ${allowedList}`);
        (error as any).status_code = 415; // Unsupported Media Type
        throw error;
      }
    }

    return { metadata };
  }

  /**
   * The origins the tus handler may answer a cross-origin request with — or `undefined` to keep the
   * tus server's own default (`*`).
   *
   * The tus handler writes its responses itself, past the API's CORS layer, and without
   * `allowedOrigins` @tus/server sets `Access-Control-Allow-Origin: *`. On a credentialed request —
   * cookie authentication with separate app and API origins — every browser refuses that, so no
   * browser upload could succeed although the server answered 201. Preflights and 401s were fine
   * (Nest answers those), which is why nothing noticed: only an AUTHENTICATED request reaches it.
   *
   * Taken from `tus.allowedOrigins` when set, else from `buildCorsConfig()` — the same decision REST,
   * GraphQL and Better-Auth make. Without credentialed CORS configured the previous default stays.
   */
  protected resolveCorsOrigins(): ((origin: string) => boolean) | undefined {
    const toOrigin = (value: string): string => {
      try {
        return new URL(value).origin;
      } catch {
        return value;
      }
    };
    const fromList = (list: string[]) => {
      const allowed = new Set(list.filter((entry) => typeof entry === 'string').map(toOrigin));
      return (origin: string) => allowed.has(toOrigin(origin));
    };

    if (Array.isArray(this.config.allowedOrigins) && this.config.allowedOrigins.length) {
      return fromList(this.config.allowedOrigins);
    }
    const options = this.options?.configService?.configFastButReadOnly ?? ConfigService.configFastButReadOnly ?? {};
    const cors = buildCorsConfig(options);
    if (cors.credentials !== true) {
      return undefined;
    }
    if (cors.origin === true) {
      return () => true;
    }
    return Array.isArray(cors.origin) ? fromList(cors.origin as string[]) : undefined;
  }

  /**
   * The VALIDATED tenant a new upload belongs to, or `undefined`.
   *
   * Only while multi-tenancy is active AND the tenant guard is registered — without it nothing can
   * validate a tenant, and a project without multi-tenancy sees no change at all. The tus routes
   * carry `@SkipTenantCheck()`, so the guard did NOT validate the request's tenant header; this asks
   * the same membership logic directly (`core-tenant-context.registry.ts`, the path GraphQL
   * subscriptions use).
   *
   * - No tenant header: `undefined` — the upload stays tenant-less, as before.
   * - A header naming a tenant the caller is an active member of (or any tenant, for an admin under
   *   `adminBypass`): that tenant.
   * - A header naming a tenant the caller is NOT a member of: the upload is REFUSED with 403. Taking
   *   the header verbatim would let anybody place a file in somebody else's tenant, and silently
   *   dropping it would store the file somewhere the caller did not ask for.
   *
   * Override to derive the tenant from somewhere else (a subdomain, an API key).
   */
  protected async resolveUploadTenantId(req: any): Promise<string | undefined> {
    const multiTenancy = ConfigService.configFastButReadOnly?.multiTenancy;
    const resolver = getTenantContextResolver();
    if (!multiTenancy || multiTenancy.enabled === false || !resolver) {
      return undefined;
    }

    const headerName = (multiTenancy.headerName ?? 'x-tenant-id').toLowerCase();
    const header = this.readRequestHeader(req, headerName)?.trim();
    if (!header) {
      return undefined;
    }

    const resolved = await resolver.resolve(this.readRequestUser(req), header);
    if (!resolved?.tenantId) {
      const error = new Error('Not a member of the requested tenant');
      (error as any).status_code = 403;
      throw error;
    }
    return resolved.tenantId;
  }

  /**
   * The authenticated caller with roles, read the same way as {@link readRequestUserId} — the roles
   * decide the admin bypass of the tenant resolution.
   */
  protected readRequestUser(req: any): undefined | { id: string; roles?: string[] } {
    const id = this.readRequestUserId(req);
    if (!id) {
      return undefined;
    }
    const user = req?.user ?? req?.runtime?.node?.req?.user ?? req?.context?.user;
    return { id, roles: Array.isArray(user?.roles) ? user.roles : undefined };
  }

  /**
   * A request header, from either request shape `@tus/server` v2 hands its hooks: the WHATWG
   * `ServerRequest` (a `Headers` object) or the original Node request behind `runtime.node.req`.
   */
  protected readRequestHeader(req: any, name: string): string | undefined {
    const fromHeaders = typeof req?.headers?.get === 'function' ? req.headers.get(name) : req?.headers?.[name];
    const value = fromHeaders ?? req?.runtime?.node?.req?.headers?.[name];
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === 'string' && single.length > 0 ? single : undefined;
  }

  /**
   * Create the TUS server instance with configured extensions
   */
  private async createTusServer(uploadDir: string): Promise<Server> {
    const datastore = (await this.createS3Store()) || new FileStore({ directory: uploadDir });
    // The store advertises what it CAN do (OPTIONS → Tus-Extension); narrowed to what is configured.
    datastore.extensions = datastore.extensions.filter(
      (extension: string) => !this.disabledExtensions().has(extension),
    );

    // @tus/server's default locker is in-memory, which is exclusive within ONE process only:
    // behind a load balancer two replicas each hold their own lock for the same upload id and
    // both accept a PATCH, interleaving two byte ranges into one file. Resumable uploads are
    // long-lived and clients retry, so requests for one upload landing on different replicas is
    // the normal case. With Redis the lock is shared; without it the default stands, which is
    // correct for the single-replica deployment that configuration describes.
    const locker = this.createLocker();

    const cors = this.resolveCorsOrigins();
    const server = new Server({
      allowedHeaders: this.config.allowedHeaders || DEFAULT_TUS_ALLOWED_HEADERS,
      // Without these, @tus/server answers every request with `Access-Control-Allow-Origin: *`,
      // which a browser refuses on a credentialed (cookie) request — see resolveCorsOrigins().
      ...(cors ? { allowedCredentials: true, allowedOrigins: cors } : {}),
      datastore,
      ...(locker ? { locker } : {}),
      maxSize: this.config.maxSize,
      // Every request that names an upload — HEAD (offset), PATCH (append bytes), DELETE
      // (terminate) — is checked against the upload's recorded owner. `tus.roles` alone cannot do
      // this: it decides who may reach the endpoint, not which upload they may touch, and the tus
      // protocol is built around a per-upload URL. Appending is the sharp end — bytes PATCHed into
      // somebody else's upload are migrated into the file store under THEIR filename.
      // The extension check sits here rather than in the overridable hooks, so a project override that
      // forgets `super` cannot reopen what the configuration switched off.
      onIncomingRequest: async (req, uploadId) => {
        this.assertExtensionEnabled(req);
        return this.assertUploadOwnership(req, uploadId);
      },
      onUploadCreate: async (req, upload) => {
        this.assertExtensionEnabled(req);
        return this.onUploadCreate(req, upload);
      },
      // Where the upload was CREATED, not a configured string: the controller may sit below a global
      // prefix, a URI version or a project's own route, none of which `path` knows — and a Location
      // pointing elsewhere breaks every resume (HEAD / PATCH answer 404).
      // Relative when asked for: by `tus.relativeLocation`, or by @tus/server's own `relativeLocation`
      // passed here by a project, which this generateUrl would otherwise silently override.
      generateUrl: (req, { host, id, proto }) => {
        const url = `${this.uploadCollectionPath(req)}/${id}`;
        const relative = this.config.relativeLocation === true || (server as any)?.options?.relativeLocation === true;
        return relative ? url : `${proto}://${host}${url}`;
      },
      onUploadFinish: async (_req, upload) => {
        try {
          await this.onUploadComplete(upload);
          return {};
        } catch (error) {
          // Do NOT swallow this. `onUploadComplete` is what moves the finished upload into its
          // permanent store; returning `{}` after it failed answers the client with a 204 that
          // says the upload completed while nothing was persisted. The client then deletes its
          // local copy and the file is gone — a silent data loss, and the one failure mode a
          // resumable-upload protocol exists to prevent. Failing loudly lets the client retry.
          this.logger.error(`Upload finish error: ${error.message}`);
          throw Object.assign(new Error(`Upload could not be stored: ${error.message}`), {
            body: 'Upload could not be stored',
            status_code: 500,
          });
        }
      },
      path: this.config.path || DEFAULT_TUS_CONFIG.path,
      respectForwardedHeaders: true,
    });

    // Every caller of getServer().handle() — the core controller and any project controller — gets
    // the response normalised before @tus/server writes to it. See normalizeEndCallback().
    const handle = server.handle.bind(server);
    server.handle = (req, res) => {
      this.normalizeEndCallback(res);
      return handle(req, res);
    };

    return server;
  }

  /**
   * Makes `res.end(callback)` safe for middlewares that patch `res.end` with the old two-argument form.
   *
   * @tus/server finishes its responses through srvx with `res.end(callback)` — a documented Node
   * signature. `compression` (and any middleware written like it) patches `res.end(chunk, encoding)`
   * and treats the first argument as a chunk unconditionally, so the callback reaches
   * `Buffer.byteLength()` and throws `ERR_INVALID_ARG_TYPE ... Received function`. The starter
   * registers `compression` with `filter: () => true, threshold: 0`, which removes the checks that
   * would otherwise skip a bodyless 204, so every finished upload failed AFTER the file had been
   * stored: the client never saw a 2xx and retried an upload that was already complete.
   *
   * The wrapper moves a function argument into the callback slot and runs it on `finish`, which is
   * what Node itself does with it — or on `close`, so a connection dropped after `end()` resolves srvx
   * too. A response destroyed before `end()` stays unresolved, exactly as with plain Node.
   * Idempotent per response. Protected so a project can widen it.
   */
  protected normalizeEndCallback(res: any): void {
    if (!res || typeof res.end !== 'function' || res[END_CALLBACK_NORMALIZED]) {
      return;
    }
    const end = res.end;
    res.end = function normalizedEnd(this: any, chunk?: unknown, encoding?: unknown, callback?: unknown) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
        encoding = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      if (typeof callback === 'function') {
        let called = false;
        const done = () => {
          if (!called) {
            called = true;
            (callback as () => void)();
          }
        };
        this.once('finish', done);
        this.once('close', done);
      }
      if (chunk === undefined) {
        return end.call(this);
      }
      return encoding === undefined ? end.call(this, chunk) : end.call(this, chunk, encoding);
    };
    res[END_CALLBACK_NORMALIZED] = true;
  }

  /**
   * Parse TUS metadata into object
   * @tus/server v2 already parses metadata into an object
   */
  private parseMetadata(metadata: Record<string, string> | string | undefined): Record<string, string> {
    if (!metadata) {
      return {};
    }

    // @tus/server v2 returns metadata as an object
    if (typeof metadata === 'object') {
      return metadata;
    }

    // Fallback for string format (legacy or raw)
    const result: Record<string, string> = {};
    const pairs = metadata.split(',');

    for (const pair of pairs) {
      const [key, value] = pair.trim().split(' ');
      if (key) {
        // Decode base64 value if present
        result[key] = value ? Buffer.from(value, 'base64').toString('utf-8') : '';
      }
    }

    return result;
  }

  /**
   * Ensure the upload directory exists
   */
  private async ensureUploadDir(uploadDir: string): Promise<void> {
    try {
      await fs.promises.mkdir(uploadDir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Delete a temporary upload file
   */
  private async deleteTemporaryFile(uploadId: string): Promise<void> {
    const uploadDir = this.config.uploadDir || DEFAULT_TUS_CONFIG.uploadDir;
    const filePath = path.join(uploadDir, uploadId);
    const infoPath = `${filePath}.json`;

    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Ignore if file doesn't exist
    }

    try {
      await fs.promises.unlink(infoPath);
    } catch {
      // Ignore if info file doesn't exist
    }
  }

  /**
   * Setup periodic cleanup of expired uploads
   */
  private setupExpirationCleanup(): void {
    const expirationConfig = this.config.expiration;
    // Handle boolean | ITusExpirationConfig type
    if (!expirationConfig) {
      return;
    }

    let expiresIn = '24h';

    // If explicitly set to false, skip
    if (typeof expirationConfig === 'boolean') {
      if (!expirationConfig) {
        return;
      }
      // If true, use defaults (expiresIn already set to '24h')
    } else {
      // ITusExpirationConfig object
      if (expirationConfig.enabled === false) {
        return;
      }
      expiresIn = expirationConfig.expiresIn || '24h';
    }

    const expirationMs = parseExpirationTime(expiresIn);

    // Run cleanup every hour
    this.cleanupInterval = setInterval(
      async () => {
        await this.cleanupExpiredUploads(expirationMs);
      },
      60 * 60 * 1000,
    );
    // An hourly sweep must never be the thing keeping the process alive.
    this.cleanupInterval.unref?.();

    this.logger.debug(`Expiration cleanup scheduled (expire after ${expiresIn})`);
  }

  /**
   * Clean up expired incomplete uploads
   */
  private async cleanupExpiredUploads(maxAgeMs: number): Promise<void> {
    if (this.s3Store) {
      // Aborted uploads live in the S3 staging bucket — expire them with a
      // bucket lifecycle rule for incomplete multipart uploads instead.
      return;
    }
    const uploadDir = this.config.uploadDir || DEFAULT_TUS_CONFIG.uploadDir;
    const now = Date.now();

    try {
      const files = await fs.promises.readdir(uploadDir);
      let cleanedCount = 0;

      for (const file of files) {
        if (file.endsWith('.json')) {
          continue; // Skip info files
        }

        const filePath = path.join(uploadDir, file);
        const stats = await fs.promises.stat(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAgeMs) {
          await this.deleteTemporaryFile(file);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        this.logger.debug(`Cleaned up ${cleanedCount} expired uploads`);
      }
    } catch (error) {
      this.logger.warn(`Failed to cleanup expired uploads: ${error.message}`);
    }
  }

  /**
   * Log which features are enabled
   */
  private logEnabledFeatures(): void {
    // What the server answers OPTIONS with, i.e. what a client can actually use — not the config flags:
    // the stores support neither checksum nor concatenation, whatever the configuration says.
    const features: string[] = [...((this.tusServer as any)?.datastore?.extensions ?? [])];

    if (features.length > 0) {
      this.logger.log(`TUS extensions: ${features.join(', ')}`);
    }

    // Log file type restrictions if configured
    if (this.config.allowedTypes && this.config.allowedTypes.length > 0) {
      this.logger.log(`TUS allowed types: ${this.config.allowedTypes.join(', ')}`);
    }
  }
}
