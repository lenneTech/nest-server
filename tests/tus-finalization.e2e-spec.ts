import * as http from 'http';
import mongoose, { Connection } from 'mongoose';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreS3Service } from '../src/core/common/services/core-s3.service';
import { CoreFileService } from '../src/core/modules/file/core-file.service';
import { FILESYSTEM_FILES_COLLECTION } from '../src/core/modules/file/filesystem-file.helper';
import { S3_FILES_COLLECTION } from '../src/core/modules/file/s3-file.helper';
import { CoreTusService } from '../src/core/modules/tus/core-tus.service';
import { dropS3Buckets } from './helpers/s3-test-cleanup';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';

/**
 * What happens to a tus upload AFTER the last byte arrives.
 *
 * `tus-s3-staging.e2e-spec.ts` covers the in-progress half — that the partial upload lives in S3 and
 * can be resumed on another replica. Nothing covered the other half, which is the one a user
 * actually notices: the finished upload has to land in whichever store `file.storage` names, be
 * readable through the very same `CoreFileService` the download routes use, and leave nothing
 * behind in the staging bucket.
 *
 * Three drivers, one staging store, and the three failure modes each guards against:
 *
 *  - **wrong store** — tus resolving the driver independently of `CoreFileService` is how an upload
 *    ends up written to one store and read from another;
 *  - **wrong path** — with S3 on both ends the object must be handed over INSIDE S3 (`CopyObject`),
 *    not pulled down and pushed back up through this process, which would pin the finishing PATCH
 *    (and its upload lock) for a full download plus a full upload;
 *  - **leaked staging** — a completed upload's staged object is NOT an incomplete multipart, so no
 *    bucket lifecycle rule reaches it. If the explicit cleanup regresses, every finished upload
 *    silently leaves a full second copy of itself behind, in a bucket that by default IS the file
 *    bucket.
 *
 * The staging bucket is deliberately SEPARATE from the file bucket here, so "the staged object is
 * gone" and "the file object is there" cannot be confused for one another.
 *
 * @regression   11.33.x — a completed tus upload's staged object is not an incomplete multipart, so
 *   nothing but the explicit cleanup reclaims it: a regression leaves a full second copy of every
 *   finished upload in the staging bucket.
 * @seen-failing Registered as mutation `tus-staged-objects-not-deleted` in
 *   tests/regression-mutations.json.
 */
const FILE_BUCKET = `nest-server-tus-final-${Date.now()}-p${process.pid}`;
const STAGING_BUCKET = `${FILE_BUCKET}-staging`;

const START_CONTAINER
  = 'docker run -d --name nest-server-2985-rustfs -p 9102:9000 -e RUSTFS_ROOT_USER=rustfs '
    + '-e RUSTFS_ROOT_PASSWORD=rustfs-secret -e RUSTFS_VOLUMES=/data rustfs/rustfs:1.0.0-rc.1 server /data';

const s3Config = {
  accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
  autoCreateBucket: true,
  bucket: FILE_BUCKET,
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
  forcePathStyle: true,
  region: 'us-east-1',
  secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
  stagingBucket: STAGING_BUCKET,
};

/** Records WHICH finalization path ran, so "it worked" cannot hide "it streamed". */
class TestTusService extends CoreTusService {
  copyDecisions: boolean[] = [];

  protected override canCopyWithinS3(upload: any): boolean {
    const decision = super.canCopyWithinS3(upload);
    this.copyDecisions.push(decision);
    return decision;
  }
}

class TestFileService extends CoreFileService {
  constructor(connection: Connection, configService: ConfigService, s3Service: CoreS3Service) {
    super(connection, 'fs', { configService, s3Service });
  }
}

describe('TUS finalization into every file storage driver (real RustFS)', () => {
  let connection: Connection;
  let configService: ConfigService;
  let s3Service: CoreS3Service;
  let previousConfig: Partial<IServerOptions>;
  let fixtureDir: string;
  const testId = `tus-final-${Date.now()}-p${process.pid}`;
  const servers: (() => Promise<void>)[] = [];

  const applyConfig = (file: Record<string, any>) =>
    ConfigService.setConfig({ ...(previousConfig as any), file, s3: s3Config } as IServerOptions, { reInit: true });

  /** A tus service on its own HTTP server, staging in S3 */
  const startTus = async (label: string): Promise<{ service: TestTusService; url: string }> => {
    const service = new TestTusService(connection, { configService, s3Service });
    service.configure({ uploadDir: path.join(fixtureDir, `${label}-tus`) });
    await service.onModuleInit();

    const server = http.createServer((req, res) => {
      void service.getServer().handle(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };

    servers.push(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await service.onModuleDestroy();
    });
    return { service, url: `http://127.0.0.1:${port}` };
  };

  const tusRequest = (
    url: string,
    options: { body?: Buffer; headers?: Record<string, string>; method: string; path: string },
  ): Promise<{ headers: http.IncomingHttpHeaders; statusCode: number }> =>
    new Promise((resolve, reject) => {
      const { port } = new URL(url);
      const req = http.request(
        {
          headers: { 'Tus-Resumable': '1.0.0', ...options.headers },
          hostname: '127.0.0.1',
          method: options.method,
          path: options.path,
          port,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ headers: res.headers, statusCode: res.statusCode }));
        },
      );
      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });

  /** Create + fully upload one file; returns the tus upload id (= the STAGING object key) */
  const uploadFully = async (url: string, filename: string, payload: Buffer): Promise<string> => {
    const created = await tusRequest(url, {
      headers: {
        'Upload-Length': String(payload.length),
        'Upload-Metadata': `filename ${Buffer.from(filename).toString('base64')},`
          + `filetype ${Buffer.from('text/plain').toString('base64')}`,
      },
      method: 'POST',
      path: '/tus',
    });
    expect(created.statusCode, 'tus creation').toBe(201);
    const uploadId = (created.headers.location as string).split('/').pop();

    const patched = await tusRequest(url, {
      body: payload,
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      method: 'PATCH',
      path: `/tus/${uploadId}`,
    });
    // 204 means the whole finish hook succeeded — it is deliberately NOT swallowed, so a failed
    // migration surfaces here rather than as a silent data loss.
    expect(patched.statusCode, 'tus completion').toBe(204);
    return uploadId;
  };

  const stagedObjectExists = async (key: string): Promise<boolean> => {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await s3Service.getClient().send(new HeadObjectCommand({ Bucket: STAGING_BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    fixtureDir = await createFixtureDir('nest-server-tus-final-');
    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    applyConfig({ storage: 's3' });
    configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });

    s3Service = new CoreS3Service(configService);
    try {
      await s3Service.onModuleInit();
      await s3Service.ensureBucket(FILE_BUCKET);
      await s3Service.ensureBucket(STAGING_BUCKET);
    } catch (error) {
      const reason
        = error instanceof Error ? error.message || (error as { code?: string }).code || error.name : String(error);
      throw new Error(
        `No S3-compatible store reachable on ${s3Config.endpoint} (${reason}). `
        + `Start the test container:\n  ${START_CONTAINER}`,
        { cause: error },
      );
    }

    connection = mongoose.createConnection(envConfig.mongoose.uri);
    await connection.asPromise();
  }, 120_000);

  afterAll(async () => {
    for (const close of servers) {
      await close().catch(() => undefined);
    }
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    for (const doc of await connection.db.collection('fs.files').find({ filename: { $regex: testId } }).toArray()) {
      await bucket.delete(doc._id).catch(() => undefined);
    }
    for (const name of [S3_FILES_COLLECTION, FILESYSTEM_FILES_COLLECTION]) {
      await connection.db.collection(name).deleteMany({ filename: { $regex: testId } });
    }
    await dropS3Buckets(s3Service?.getClient(), [FILE_BUCKET, STAGING_BUCKET]);
    await s3Service?.onApplicationShutdown();
    await connection?.close();
    await removeFixtureDir(fixtureDir);
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 120_000);

  it('hands an S3→S3 upload over inside S3 and clears the staging bucket', async () => {
    applyConfig({ storage: 's3' });
    const { service, url } = await startTus('to-s3');
    const filename = `${testId}-to-s3.txt`;
    const payload = Buffer.from('finished upload, copied inside s3');

    const uploadId = await uploadFully(url, filename, payload);

    // The copy path, not the streaming one — "it worked" must not hide "it streamed".
    expect(service.copyDecisions).toEqual([true]);

    const fileService = new TestFileService(connection, configService, s3Service);
    const info = await fileService.getFileInfoByName(filename);
    expect(info, 'the finished upload must be readable through CoreFileService').toBeTruthy();
    expect((await fileService.getBuffer(info.id)).toString()).toBe(payload.toString());
    expect(info.contentType).toBe('text/plain');
    expect(await s3Service.objectExists(String(info.id))).toBe(true);

    // Nothing left in staging — neither the object nor its `.info` sidecar. A completed upload is
    // not an incomplete multipart, so no lifecycle rule would ever reclaim these.
    expect(await stagedObjectExists(uploadId)).toBe(false);
    expect(await stagedObjectExists(`${uploadId}.info`)).toBe(false);
  }, 120_000);

  it('streams an S3-staged upload into GridFS when that is the active driver', async () => {
    applyConfig({ storage: 'gridfs' });
    const { service, url } = await startTus('to-gridfs');
    const filename = `${testId}-to-gridfs.txt`;
    const payload = Buffer.from('finished upload, migrated to gridfs');

    const uploadId = await uploadFully(url, filename, payload);

    // No S3 on the receiving end, so the bytes genuinely have to transit this process.
    expect(service.copyDecisions).toEqual([false]);

    const fileService = new TestFileService(connection, configService, s3Service);
    const info = await fileService.getFileInfoByName(filename);
    expect(info).toBeTruthy();
    expect((await fileService.getBuffer(info.id)).toString()).toBe(payload.toString());
    // In GridFS, and NOT in the S3 metadata store — tus must not write where the active driver isn't.
    expect(await connection.db.collection('fs.files').find({ filename }).toArray()).toHaveLength(1);
    expect(await connection.db.collection(S3_FILES_COLLECTION).findOne({ filename })).toBeNull();

    expect(await stagedObjectExists(uploadId)).toBe(false);
    expect(await stagedObjectExists(`${uploadId}.info`)).toBe(false);
  }, 120_000);

  it('streams an S3-staged upload onto the filesystem when that is the active driver', async () => {
    const storageDir = path.join(fixtureDir, 'final-filesystem');
    applyConfig({ storage: 'filesystem', storageDir });
    const { service, url } = await startTus('to-filesystem');
    const filename = `${testId}-to-filesystem.txt`;
    const payload = Buffer.from('finished upload, migrated to the filesystem');

    const uploadId = await uploadFully(url, filename, payload);

    expect(service.copyDecisions).toEqual([false]);

    const fileService = new TestFileService(connection, configService, s3Service);
    const info = await fileService.getFileInfoByName(filename);
    expect(info).toBeTruthy();
    expect((await fileService.getBuffer(info.id)).toString()).toBe(payload.toString());
    expect(await connection.db.collection(FILESYSTEM_FILES_COLLECTION).findOne({ filename })).toBeTruthy();
    expect(await connection.db.collection('fs.files').find({ filename }).toArray()).toHaveLength(0);

    expect(await stagedObjectExists(uploadId)).toBe(false);
    expect(await stagedObjectExists(`${uploadId}.info`)).toBe(false);
  }, 120_000);
});
