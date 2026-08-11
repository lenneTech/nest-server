import mongoose, { Connection } from 'mongoose';
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreS3Service } from '../src/core/common/services/core-s3.service';
import { CoreFileService } from '../src/core/modules/file/core-file.service';
import { S3_FILES_COLLECTION } from '../src/core/modules/file/s3-file.helper';
import { dropS3Buckets } from './helpers/s3-test-cleanup';

/**
 * Drives `CoreFileService` with `file.storage: 's3'` against a REAL
 * S3-compatible store (RustFS).
 *
 * `s3-infra.e2e-spec.ts` covers `CoreS3Service` — the transport. This covers the
 * FILE SERVICE on top of it, which is a different thing and the one projects
 * actually call: that writes land in S3 rather than GridFS, that the metadata
 * row is written, that reads still find pre-existing GridFS files, and that a
 * delete removes both the object and its bookkeeping.
 *
 * Locally: dedicated container on localhost:9102 (see s3-infra.e2e-spec.ts for
 * the docker command); in CI: the ci-rustfs service. The suite FAILS rather than
 * skips when the store is missing — a silently skipped storage test is how an
 * untested driver ships.
 */
const RUN_BUCKET = `nest-server-filesvc-${Date.now()}-p${process.pid}`;

const s3Config = {
  accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
  autoCreateBucket: true,
  bucket: RUN_BUCKET,
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
  forcePathStyle: true,
  region: 'us-east-1',
  secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
};

class TestFileService extends CoreFileService {
  constructor(connection: Connection, configService: ConfigService, s3Service: CoreS3Service) {
    super(connection, 'fs', { configService, s3Service });
  }
}

const upload = (content: string, filename: string) => ({
  createReadStream: () => Readable.from([content]),
  filename,
  mimetype: 'text/plain',
});

describe('File storage driver: S3 (real RustFS)', () => {
  let connection: Connection;
  let configService: ConfigService;
  let s3Service: CoreS3Service;
  let service: TestFileService;
  let previousConfig: Partial<IServerOptions>;
  const testId = `s3svc-${Date.now()}`;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    ConfigService.setConfig(
      { ...(previousConfig as any), file: { storage: 's3' }, s3: s3Config } as IServerOptions,
      { reInit: true },
    );
    configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });

    s3Service = new CoreS3Service(configService);
    try {
      await s3Service.onModuleInit();
    } catch (error) {
      throw new Error(
        `This suite needs an S3-compatible store on ${s3Config.endpoint} `
          + `(${error instanceof Error ? error.message : String(error)}). See s3-infra.e2e-spec.ts for the container.`,
        { cause: error },
      );
    }

    connection = mongoose.createConnection(envConfig.mongoose.uri);
    await connection.asPromise();
    service = new TestFileService(connection, configService, s3Service);
  }, 60_000);

  afterAll(async () => {
    await connection?.db?.collection(S3_FILES_COLLECTION).deleteMany({ filename: { $regex: testId } });
    await dropS3Buckets(s3Service?.getClient(), [RUN_BUCKET]);
    await s3Service?.onApplicationShutdown();
    await connection?.close();
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 60_000);

  it('resolves the S3 driver and boots without falling back', () => {
    expect(service['storageDriver']).toBe('s3');
    expect(service['storageResolution'].explicit).toBe(true);
  });

  it('writes new files to S3, not to GridFS', async () => {
    const filename = `${testId}-written.txt`;

    const info = await service.createFile(upload('written to s3', filename));

    expect(info.id).toBeTruthy();
    // Object in the bucket, keyed by id…
    expect(await s3Service.objectExists(String(info.id))).toBe(true);
    // …metadata row in its collection…
    const doc = await connection.db.collection(S3_FILES_COLLECTION).findOne({ _id: new mongoose.Types.ObjectId(info.id) });
    expect(doc?.filename).toBe(filename);
    // …and nothing in GridFS.
    expect(await connection.db.collection('fs.files').find({ filename }).toArray()).toHaveLength(0);
  });

  it('round-trips content through the service', async () => {
    const filename = `${testId}-roundtrip.txt`;
    const content = 'round trip through s3';

    const info = await service.createFile(upload(content, filename));

    expect((await service.getBuffer(info.id)).toString()).toBe(content);
    expect((await service.getFileInfo(info.id)).filename).toBe(filename);
    expect((await service.getFileInfoByName(filename)).id).toBe(info.id);

    const chunks: Buffer[] = [];
    for await (const chunk of await service.getFileStream(info.id)) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe(content);
  });

  it('carries custom metadata through, so a per-file rule has something to read', async () => {
    const filename = `${testId}-owned.txt`;

    const info = await service.createFile(upload('owned', filename), { metadata: { ownerId: 'user-7' } });

    // The read side of checkRights() must find it under this driver too.
    const raw = await service['getRawFileInfo'](info.id);
    expect(raw?.metadata?.ownerId).toBe('user-7');
  });

  it('still reads files written under a PREVIOUS driver', async () => {
    // Forward-only: switching to S3 keeps everything already in GridFS readable.
    const filename = `${testId}-legacy-gridfs.txt`;
    const content = 'stored in gridfs before the switch';

    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    const legacyId = await new Promise<any>((resolve, reject) => {
      const stream = bucket.openUploadStream(filename);
      stream.on('error', reject);
      stream.on('finish', () => resolve(stream.id));
      Readable.from([content]).pipe(stream);
    });

    expect((await service.getFileInfo(legacyId)).filename).toBe(filename);
    expect((await service.getBuffer(legacyId)).toString()).toBe(content);

    await service.deleteFile(legacyId);
    expect(await service.getFileInfo(legacyId)).toBeNull();
  });

  it('deletes both the object and its metadata', async () => {
    const filename = `${testId}-deleted.txt`;
    const info = await service.createFile(upload('to be deleted', filename));
    expect(await s3Service.objectExists(String(info.id))).toBe(true);

    await service.deleteFile(info.id);

    expect(await s3Service.objectExists(String(info.id))).toBe(false);
    expect(await service.getFileInfo(info.id)).toBeNull();
  });

  it('merges both stores in findFileInfo', async () => {
    const marker = `${testId}-merged-${Math.random().toString(36).substring(7)}`;

    await service.createFile(upload('s3 side', `${marker}-a.txt`));
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    await new Promise<void>((resolve, reject) => {
      const stream = bucket.openUploadStream(`${marker}-b.txt`);
      stream.on('error', reject);
      stream.on('finish', () => resolve());
      Readable.from(['gridfs side']).pipe(stream);
    });

    const names = (await service.findFileInfo()).map(file => file.filename);
    expect(names).toContain(`${marker}-a.txt`);
    expect(names).toContain(`${marker}-b.txt`);
    expect(names.filter(name => name === `${marker}-a.txt`)).toHaveLength(1);

    for (const doc of await connection.db.collection('fs.files').find({ filename: { $regex: marker } }).toArray()) {
      await bucket.delete(doc._id);
    }
  });
});
