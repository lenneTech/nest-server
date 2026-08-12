/**
 * The DRIVER HARNESS behind the file-storage parity matrix.
 *
 * `file-storage-matrix.ts` says WHAT must hold; this says how to put each of the three drivers into
 * a runnable state and how to reach past the active one — which is the part every previous
 * single-driver suite had to re-invent, slightly differently, three times.
 *
 * Two decisions here are load-bearing:
 *
 * 1. **S3 stays WIRED for every driver.** `CoreFileService` gates its S3 lookups on whether S3 is
 *    USABLE, not on whether it is the active write driver — that is what makes "switching drivers
 *    is forward-only, no migration" true in BOTH directions (adopting S3 keeps GridFS readable, and
 *    switching back keeps S3 readable). A harness that only wires S3 while `file.storage: 's3'`
 *    cannot observe the second direction at all, and that direction is the one that regressed.
 *    So one `CoreS3Service` is built once and handed to every service instance; only `file.storage`
 *    changes per driver.
 *
 * 2. **Writing into a NON-active store goes through the store's own helper**, never through the
 *    service. The service always writes to the active driver — by design — so a cross-driver
 *    fixture has to be planted directly. That is also exactly what a project that switched drivers
 *    has: rows in a store nothing writes to any more.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Connection, mongo, Types } from 'mongoose';
import { Readable } from 'stream';

import { GridFSHelper } from '../../src/core/common/helpers/gridfs.helper';
import { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreS3Service } from '../../src/core/common/services/core-s3.service';
import { CoreFileService, FileInputCheckType } from '../../src/core/modules/file/core-file.service';
import {
  FILESYSTEM_FILES_COLLECTION,
  FilesystemFileHelper,
} from '../../src/core/modules/file/filesystem-file.helper';
import { FileServiceOptions } from '../../src/core/modules/file/interfaces/file-service-options.interface';
import { S3_FILES_COLLECTION, S3FileHelper } from '../../src/core/modules/file/s3-file.helper';
import { ParityDriver } from './file-storage-matrix';

export const GRIDFS_FILES_COLLECTION = 'fs.files';

/** Where each driver keeps its bookkeeping. Reads stay queryable whichever store holds the bytes. */
export const METADATA_COLLECTION: Record<ParityDriver, string> = {
  filesystem: FILESYSTEM_FILES_COLLECTION,
  gridfs: GRIDFS_FILES_COLLECTION,
  s3: S3_FILES_COLLECTION,
};

/**
 * A rule injected into the service under test, so the matrix can drive `checkRights()` without a
 * full app.
 *
 * Deliberately the SAME SHAPE as the reference server's rule (`src/server/modules/file/file.service.ts`):
 * fails closed on a missing user, covers the `id` AND the `filename` branch, admits ADMIN. A
 * permissive stand-in would make `service.deleteByNameForwardsContext` pass with the 11.33.1 bug
 * fully present — the context-less inner lookup would simply succeed. That is the vacuity trap this
 * whole exercise exists to close, so the rule is not configurable down to "allow everything".
 */
export type ParityRightsRule = (
  input: any,
  options: FileServiceOptions & { checkInputType: FileInputCheckType },
) => Promise<boolean> | boolean;

/**
 * Test subclass exposing the protected seam the matrix has to observe.
 *
 * `getRawFileInfo` / `getRawFileInfoByName` are `protected` because they are for an overridden
 * `checkRights()`, not for building responses — but they ARE the read side of every per-file rule a
 * consumer writes, so the matrix has to be able to call them. Exposing them through a subclass is
 * how a consumer would reach them too; string-indexing (`service['getRawFileInfo']`) would type-check
 * a typo.
 */
export class ParityFileService extends CoreFileService {
  private rule?: ParityRightsRule;

  constructor(connection: Connection, s3Service?: CoreS3Service, configService?: ConfigService) {
    super(connection, 'fs', { configService, s3Service });
  }

  get driver() {
    return this.storageDriver;
  }

  get resolution() {
    return this.storageResolution;
  }

  rawById(id: string | Types.ObjectId) {
    return this.getRawFileInfo(id);
  }

  rawByName(filename: string) {
    return this.getRawFileInfoByName(filename);
  }

  /** Install the per-file rule. Without one the service behaves like the framework default (allow). */
  useRule(rule: ParityRightsRule | undefined) {
    this.rule = rule;
  }

  protected override async checkRights(
    input: any,
    options?: FileServiceOptions & { checkInputType: FileInputCheckType },
  ): Promise<boolean> {
    if (!this.rule || !options) {
      return true;
    }
    return this.rule(input, options);
  }
}

/**
 * The ownership rule the matrix runs with — a copy of the shipped reference implementation.
 *
 * Kept as a function rather than inlined so both executors and the mutation registry point at ONE
 * definition of "what a consumer's rule looks like".
 */
export function ownerOnlyRule(service: ParityFileService, adminIds: string[] = []): ParityRightsRule {
  return async (input, options) => {
    if (options.force || (options.checkInputType !== 'filename' && options.checkInputType !== 'id')) {
      return true;
    }
    const currentUserId = options.currentUser?.id;
    if (currentUserId && adminIds.includes(String(currentUserId))) {
      return true;
    }
    const raw =
      options.checkInputType === 'id' ? await service.rawById(input) : await service.rawByName(input);
    // Fails closed without a user: `String(undefined)` cannot equal a real owner id. Requiring the
    // owner to be PRESENT is load-bearing too — otherwise an owner-less file would compare
    // 'undefined' against 'undefined' and match.
    return !!raw?.metadata?.ownerId && String(raw.metadata.ownerId) === String(currentUserId);
  };
}

export interface ParityFixture {
  filename: string;
  id: string;
}

export interface PlantOptions {
  content: string;
  contentType?: string;
  filename: string;
  metadata?: Record<string, any>;
}

/**
 * Everything a parity executor needs, built once per spec file.
 */
export interface ParityEnvironment {
  /** Bucket this run created (named per run, removed in teardown — see helpers/s3-test-cleanup.ts). */
  bucket: string;
  /** Filesystem-driver storage directory. */
  directory: string;
  /** Metadata document of a file, read straight out of the store's own collection. */
  metadataDoc(driver: ParityDriver, id: string): Promise<any>;
  /** Whether the store physically holds the bytes of `id`. */
  holdsBytes(driver: ParityDriver, id: string): Promise<boolean>;
  /** Write a file DIRECTLY into a store, bypassing the active driver. */
  plant(driver: ParityDriver, options: PlantOptions): Promise<ParityFixture>;
  s3Service: CoreS3Service;
  /** Unique per run + per worker, so fixtures of concurrent runs cannot collide. */
  testId: string;
}

/** A GraphQL-upload-shaped source, which is what `createFile()` takes. */
export function upload(content: string, filename: string, mimetype = 'text/plain') {
  return { createReadStream: () => Readable.from([content]), filename, mimetype };
}

/**
 * Put the process into the configuration the given driver needs.
 *
 * Only `file.storage` varies — `s3` and `file.storageDir` are present for EVERY driver on purpose
 * (see the module docblock). Returns the previous config so the caller can restore it: the frozen
 * config is per worker and shared with every other suite in that worker.
 */
export function applyParityConfig(options: {
  base?: Partial<IServerOptions>;
  bucket: string;
  directory: string;
  driver: ParityDriver;
}): void {
  const { base, bucket, directory, driver } = options;
  ConfigService.setConfig(
    {
      ...((base ?? {}) as any),
      file: { ...(base as any)?.file, storage: driver, storageDir: directory },
      s3: {
        accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
        autoCreateBucket: true,
        bucket,
        endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
        forcePathStyle: true,
        region: 'us-east-1',
        secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
      },
    } as IServerOptions,
    { reInit: true },
  );
}

export function restoreConfig(previous?: Partial<IServerOptions>): void {
  // A worker that never initialized the config (a service-level spec can reach this state) has
  // nothing to restore, and `setConfig(undefined)` would throw during teardown — which turns a
  // green run red for a reason that has nothing to do with the assertions.
  if (!previous) {
    return;
  }
  ConfigService.setConfig(previous as IServerOptions, { reInit: true });
}

/**
 * Build the shared environment: temp directory, per-run bucket, a live `CoreS3Service`.
 *
 * FAILS rather than skips when the S3 store is unreachable — see `failMissingInfrastructure()`.
 */
export async function createParityEnvironment(options: {
  base?: Partial<IServerOptions>;
  connection: Connection;
  label: string;
}): Promise<{ configService: ConfigService; env: ParityEnvironment; teardown: () => Promise<void> }> {
  const { base, connection, label } = options;
  const testId = `${label}-${Date.now()}-p${process.pid}`;
  const bucket = `nest-server-${label}-${Date.now()}-p${process.pid}`;
  const directory = path.join(tmpdir(), `nest-server-${testId}`);

  // The S3 block has to be in the config BEFORE CoreS3Service is constructed — it reads it there.
  applyParityConfig({ base, bucket, directory, driver: 'gridfs' });
  const configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });
  const s3Service = new CoreS3Service(configService);
  await s3Service.onModuleInit();

  const bucketFor = (driver: ParityDriver) => connection.db.collection(METADATA_COLLECTION[driver]);
  const gridFsBucket = () => new mongo.GridFSBucket(connection.db, { bucketName: 'fs' });

  const env: ParityEnvironment = {
    bucket,
    directory,
    async holdsBytes(driver, id) {
      if (driver === 's3') {
        return s3Service.objectExists(String(id));
      }
      if (driver === 'filesystem') {
        try {
          await FilesystemFileHelper.getBuffer(directory, id);
          return true;
        } catch {
          return false;
        }
      }
      // GridFS: a files document can outlive its chunks, so ask for the CHUNKS.
      const chunks = await connection.db
        .collection('fs.chunks')
        .countDocuments({ files_id: new Types.ObjectId(id) });
      return chunks > 0;
    },
    async metadataDoc(driver, id) {
      return bucketFor(driver).findOne({ _id: new Types.ObjectId(id) });
    },
    async plant(driver, plantOptions) {
      const { content, contentType = 'text/plain', filename, metadata } = plantOptions;
      if (driver === 'filesystem') {
        const info = await FilesystemFileHelper.writeFile(directory, bucketFor('filesystem'), {
          buffer: Buffer.from(content),
          contentType,
          filename,
          ...(metadata ? { metadata } : {}),
        });
        return { filename, id: info._id.toHexString() };
      }
      if (driver === 's3') {
        const info = await S3FileHelper.writeFile(s3Service, bucketFor('s3'), {
          buffer: Buffer.from(content),
          contentType,
          filename,
          ...(metadata ? { metadata } : {}),
        });
        return { filename, id: info._id.toHexString() };
      }
      const info = await GridFSHelper.writeFileFromStream(gridFsBucket(), Readable.from([content]), {
        contentType,
        filename,
        ...(metadata ? { metadata } : {}),
      });
      return { filename, id: String(info._id) };
    },
    s3Service,
    testId,
  };

  const teardown = async () => {
    // Metadata rows first: every fixture name carries `testId`, so this cannot touch another
    // suite's data even while sharing a worker database.
    for (const collection of Object.values(METADATA_COLLECTION)) {
      await connection.db
        .collection(collection)
        .deleteMany({ filename: { $regex: testId } })
        .catch(() => undefined);
    }
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
  };

  return { configService, env, teardown };
}
