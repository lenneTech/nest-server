import { NotFoundException } from '@nestjs/common';
import { rm } from 'fs/promises';
import mongoose, { Connection } from 'mongoose';
import { tmpdir } from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreS3Service } from '../src/core/common/services/core-s3.service';
import { CoreFileService, CoreFileServiceOptions, FileInputCheckType } from '../src/core/modules/file/core-file.service';
import { FILESYSTEM_FILES_COLLECTION } from '../src/core/modules/file/filesystem-file.helper';
import { FileServiceOptions } from '../src/core/modules/file/interfaces/file-service-options.interface';
import { S3_FILES_COLLECTION } from '../src/core/modules/file/s3-file.helper';
import { dropS3Buckets } from './helpers/s3-test-cleanup';

/**
 * `duplicateByName()` / `duplicateById()` under all three storage drivers.
 *
 * Both methods used to take NO `serviceOptions` at all, which made them behave
 * in three mutually inconsistent ways as soon as a project overrode
 * `checkRights()` fail-closed — the shape the framework docs, the reference
 * server and the starter all teach:
 *
 *  - `duplicateById()` re-resolved the source with an EMPTY context, got `null`
 *    back and then dereferenced it (`file.filename`) — a `TypeError` where a
 *    `404` belongs, under EVERY driver.
 *  - `duplicateByName()` on the GridFS driver went straight to the bucket and
 *    copied the file with NO rights check whatsoever, while the same call on the
 *    S3 / filesystem drivers failed with a helper-level error.
 *
 * So the suite asserts three properties per driver: a refusal is a clean
 * refusal, an authorized duplicate works, and the copy carries the source's
 * content type (which the GridFS by-name path silently dropped).
 *
 * @regression   11.33.1 — duplicateByName() / duplicateById() accepted no `serviceOptions`, so
 *   under a fail-closed checkRights() the by-id path dereferenced null (`file.filename`) and the
 *   GridFS by-name path copied the file with no rights check at all.
 * @seen-failing Registered as mutations `duplicate-by-name-drops-context` and
 *   `duplicate-by-id-null-deref` in tests/regression-mutations.json.
 */

const OWNER = 'owner-4711';

/** `FileServiceOptions.currentUser` requires `hasRole`, so the fixtures carry one. */
const asUser = (id: string) => ({ hasRole: () => false, id });

class TestFileService extends CoreFileService {
  constructor(connection: Connection, options?: CoreFileServiceOptions) {
    super(connection, 'fs', options);
  }
}

/**
 * The per-file rule from `src/server/modules/file/file.service.ts`, i.e. the one
 * the README teaches: ADMIN-less, owner-scoped and fail-closed on a missing user.
 */
class OwnerScopedFileService extends TestFileService {
  protected override async checkRights(
    input: any,
    options?: { checkInputType: FileInputCheckType } & FileServiceOptions,
  ): Promise<boolean> {
    if (options?.force || (options?.checkInputType !== 'filename' && options?.checkInputType !== 'id')) {
      return true;
    }
    const raw
      = options.checkInputType === 'id' ? await this.getRawFileInfo(input) : await this.getRawFileInfoByName(input);
    return !!raw?.metadata?.ownerId && String(raw.metadata.ownerId) === String(options.currentUser?.id);
  }
}

const upload = (content: string, filename: string) => ({
  createReadStream: () => Readable.from([content]),
  filename,
  mimetype: 'text/plain',
});

/**
 * Assert the exception TYPE, not just its text — a message match alone can be
 * satisfied by the MongoDB driver's own `MongoRuntimeError: File not found for
 * id …`, which is an HTTP 500 rather than the 404 this contract is about.
 */
const expectNotFound = async (promise: Promise<unknown>): Promise<void> => {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error, 'expected the call to reject').not.toBeNull();
  expect(error).toBeInstanceOf(NotFoundException);
  expect((error as NotFoundException).getStatus()).toBe(404);
};

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
};

interface DriverHarness {
  /** Extra `super()` options the driver needs (S3 forwards its service) */
  options?: CoreFileServiceOptions;
  /** Prepare the global config for this driver; return a teardown */
  setUp: () => Promise<() => Promise<void>>;
}

/**
 * One suite, run against each driver. The assertions are deliberately identical:
 * the whole point is that the three drivers answer the same way.
 */
function describeDuplicates(driver: string, harness: () => DriverHarness) {
  describe(`CoreFileService duplication — ${driver} driver`, () => {
    let connection: Connection;
    let tearDown: () => Promise<void>;
    let options: CoreFileServiceOptions | undefined;
    const testId = `dup-${driver}-${Date.now()}-p${process.pid}`;

    beforeAll(async () => {
      const prepared = harness();
      tearDown = await prepared.setUp();
      options = prepared.options;
      connection = mongoose.createConnection(envConfig.mongoose.uri);
      await connection.asPromise();
    }, 60_000);

    afterAll(async () => {
      const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
      for (const doc of await connection.db.collection('fs.files').find({ filename: { $regex: testId } }).toArray()) {
        await bucket.delete(doc._id).catch(() => undefined);
      }
      for (const name of [S3_FILES_COLLECTION, FILESYSTEM_FILES_COLLECTION]) {
        await connection.db.collection(name).deleteMany({ filename: { $regex: testId } });
      }
      await connection?.close();
      await tearDown?.();
    }, 60_000);

    it('duplicates by id without a context when checkRights is the framework default', async () => {
      // Backward compatibility: a project that never overrode checkRights() must
      // keep the pre-11.34.0 call shape working unchanged.
      const service = new TestFileService(connection, options);
      const filename = `${testId}-default-id.txt`;
      const source = await service.createFile(upload('default rules', filename));

      const copyId = await service.duplicateById(source.id);

      expect(copyId).toBeTruthy();
      expect(copyId).not.toBe(source.id);
      expect((await service.getBuffer(copyId)).toString()).toBe('default rules');
      expect((await service.getFileInfo(copyId)).filename).toBe(filename);
    });

    it('duplicates by name without a context when checkRights is the framework default', async () => {
      const service = new TestFileService(connection, options);
      const filename = `${testId}-default-name.txt`;
      const newName = `${testId}-default-name-copy.txt`;
      await service.createFile(upload('default rules by name', filename));

      await service.duplicateByName(filename, newName);

      const copy = await service.getFileInfoByName(newName);
      expect(copy).toBeTruthy();
      expect(await readAll(await service.getFileStreamByName(newName))).toBe('default rules by name');
    });

    it('carries the source content type into the copy', async () => {
      // The GridFS by-name path opened its upload stream WITHOUT a content type,
      // so the copy downloaded as application/octet-stream while the same call on
      // S3 / filesystem preserved text/plain.
      const service = new TestFileService(connection, options);
      const filename = `${testId}-ctype.txt`;
      const newName = `${testId}-ctype-copy.txt`;
      const source = await service.createFile(upload('typed', filename));

      await service.duplicateByName(filename, newName);
      const byIdCopyId = await service.duplicateById(source.id);

      expect((await service.getFileInfoByName(newName)).contentType).toBe('text/plain');
      expect((await service.getFileInfo(byIdCopyId)).contentType).toBe('text/plain');
    });

    it('refuses a context-less duplicateById cleanly instead of crashing', async () => {
      const writer = new TestFileService(connection, options);
      const service = new OwnerScopedFileService(connection, options);
      const filename = `${testId}-noctx-id.txt`;
      const source = await writer.createFile(upload('owned bytes', filename), { metadata: { ownerId: OWNER } });

      // Was: TypeError: Cannot read properties of null (reading 'filename')
      await expectNotFound(service.duplicateById(source.id));
    });

    it('refuses a context-less duplicateByName instead of copying unchecked', async () => {
      const writer = new TestFileService(connection, options);
      const service = new OwnerScopedFileService(connection, options);
      const filename = `${testId}-noctx-name.txt`;
      const newName = `${testId}-noctx-name-copy.txt`;
      await writer.createFile(upload('owned bytes', filename), { metadata: { ownerId: OWNER } });

      // Was on GridFS: a successful, entirely unchecked copy of someone else's file.
      await expectNotFound(service.duplicateByName(filename, newName));
      expect(await writer.getFileInfoByName(newName)).toBeNull();
    });

    it('refuses a duplicate for a caller who is not the owner', async () => {
      const writer = new TestFileService(connection, options);
      const service = new OwnerScopedFileService(connection, options);
      const filename = `${testId}-stranger.txt`;
      const newName = `${testId}-stranger-copy.txt`;
      const source = await writer.createFile(upload('owned bytes', filename), { metadata: { ownerId: OWNER } });
      const stranger = { currentUser: asUser('someone-else') };

      await expectNotFound(service.duplicateById(source.id, stranger));
      await expectNotFound(service.duplicateByName(filename, newName, stranger));
      expect(await writer.getFileInfoByName(newName)).toBeNull();
    });

    it('duplicates for the owner when the context is forwarded', async () => {
      const writer = new TestFileService(connection, options);
      const service = new OwnerScopedFileService(connection, options);
      const filename = `${testId}-owner.txt`;
      const newName = `${testId}-owner-copy.txt`;
      const source = await writer.createFile(upload('owned bytes', filename), { metadata: { ownerId: OWNER } });
      const owner = { currentUser: asUser(OWNER) };

      const copyId = await service.duplicateById(source.id, owner);
      await service.duplicateByName(filename, newName, owner);

      expect(await readAll(await writer.getFileStream(copyId))).toBe('owned bytes');
      expect(await readAll(await writer.getFileStreamByName(newName))).toBe('owned bytes');
    });

    it('lets the caller record the copy\'s own metadata', async () => {
      // A duplicate deliberately does NOT inherit the source's metadata (that would
      // silently hand the copy the source's owner). The caller states it instead.
      const writer = new TestFileService(connection, options);
      const service = new OwnerScopedFileService(connection, options);
      const filename = `${testId}-meta.txt`;
      const source = await writer.createFile(upload('owned bytes', filename), { metadata: { ownerId: OWNER } });

      const copyId = await service.duplicateById(source.id, {
        currentUser: asUser(OWNER),
        metadata: { copiedFrom: source.id, ownerId: OWNER },
      });

      const raw = await writer['getRawFileInfo'](copyId);
      expect(raw?.metadata?.ownerId).toBe(OWNER);
      expect(raw?.metadata?.copiedFrom).toBe(source.id);
      // …and the copy is reachable through the owner rule that the source was.
      expect(await service.getFileInfo(copyId, { currentUser: asUser(OWNER) })).toBeTruthy();
    });
  });
}

// ---------------------------------------------------------------------------
// GridFS — the pre-11.33 default, so this path must be the smoothest of all
// ---------------------------------------------------------------------------
describeDuplicates('gridfs', () => ({
  setUp: async () => {
    const previous = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    ConfigService.setConfig({ ...(previous as any), file: { storage: 'gridfs' } } as IServerOptions, { reInit: true });
    return async () => {
      ConfigService.setConfig(previous as IServerOptions, { reInit: true });
    };
  },
}));

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------
describeDuplicates('filesystem', () => {
  const directory = path.join(tmpdir(), `nest-server-dup-${Date.now()}-p${process.pid}`);
  return {
    setUp: async () => {
      const previous = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
      ConfigService.setConfig(
        { ...(previous as any), file: { storage: 'filesystem', storageDir: directory } } as IServerOptions,
        { reInit: true },
      );
      return async () => {
        await rm(directory, { force: true, recursive: true });
        ConfigService.setConfig(previous as IServerOptions, { reInit: true });
      };
    },
  };
});

// ---------------------------------------------------------------------------
// S3 (real RustFS — see s3-infra.e2e-spec.ts for the container)
// ---------------------------------------------------------------------------
describeDuplicates('s3', () => {
  const bucket = `nest-server-dup-${Date.now()}-p${process.pid}`;
  const s3Config = {
    accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
    autoCreateBucket: true,
    bucket,
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
    forcePathStyle: true,
    region: 'us-east-1',
    secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
  };
  const harness: DriverHarness = {
    setUp: async () => {
      const previous = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
      ConfigService.setConfig(
        { ...(previous as any), file: { storage: 's3' }, s3: s3Config } as IServerOptions,
        { reInit: true },
      );
      const configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });
      const s3Service = new CoreS3Service(configService);
      try {
        await s3Service.onModuleInit();
      } catch (error) {
        throw new Error(
          `This suite needs an S3-compatible store on ${s3Config.endpoint} `
          + `(${error instanceof Error ? error.message : String(error)}). See s3-infra.e2e-spec.ts for the container.`,
          { cause: error },
        );
      }
      harness.options = { configService, s3Service };
      return async () => {
        await dropS3Buckets(s3Service.getClient(), [bucket]);
        await s3Service.onApplicationShutdown();
        ConfigService.setConfig(previous as IServerOptions, { reInit: true });
      };
    },
  };
  return harness;
});
