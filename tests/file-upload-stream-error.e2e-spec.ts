import { rm } from 'fs/promises';
import mongoose, { Connection } from 'mongoose';
import { tmpdir } from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import envConfig from '../src/config.env';
import { GridFSHelper } from '../src/core/common/helpers/gridfs.helper';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreS3Service } from '../src/core/common/services/core-s3.service';
import { CoreFileService } from '../src/core/modules/file/core-file.service';
import { FILESYSTEM_FILES_COLLECTION } from '../src/core/modules/file/filesystem-file.helper';
import { S3_FILES_COLLECTION, S3FileHelper } from '../src/core/modules/file/s3-file.helper';
import { dropS3Buckets } from './helpers/s3-test-cleanup';

/**
 * An upload whose SOURCE stream fails — the shape a client that aborts a
 * `multipart`/GraphQL upload mid-body produces.
 *
 * `pipe()` does not forward source errors, and `GridFSHelper.writeFileFromStream`
 * listened only on the destination. An unhandled `'error'` event is an uncaught
 * exception in Node, so this took the whole PROCESS down rather than failing the
 * one request — and it was driver-conditional: the same abort is a rejected
 * promise under the S3 and filesystem drivers, and a crash under GridFS, which
 * is the driver every pre-11.33 project runs.
 *
 * @regression   11.33.1 — GridFSHelper.writeFileFromStream() had no handler on the SOURCE stream,
 *   so an aborted upload raised an unhandled 'error' and ended the process.
 * @seen-failing Registered as mutation `gridfs-upload-source-error-unhandled` in
 *   tests/regression-mutations.json.
 */
class TestFileService extends CoreFileService {
  constructor(connection: Connection) {
    super(connection, 'fs');
  }
}

const exploding = (message: string) =>
  new Readable({
    read() {
      this.destroy(new Error(message));
    },
  });

describe('Upload with a failing source stream (e2e)', () => {
  let connection: Connection;
  let previousConfig: Partial<IServerOptions>;
  let directory: string;
  const marker = `stream-error-${Date.now()}-p${process.pid}`;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    directory = path.join(tmpdir(), `nest-server-stream-error-${Date.now()}-p${process.pid}`);
    connection = mongoose.createConnection(envConfig.mongoose.uri);
    await connection.asPromise();
  }, 60_000);

  afterAll(async () => {
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    for (const doc of await connection.db.collection('fs.files').find({ filename: { $regex: marker } }).toArray()) {
      await bucket.delete(doc._id).catch(() => undefined);
    }
    await connection.db.collection(FILESYSTEM_FILES_COLLECTION).deleteMany({ filename: { $regex: marker } });
    await connection?.close();
    await rm(directory, { force: true, recursive: true });
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 60_000);

  it('rejects instead of crashing the process when the GridFS source stream fails', async () => {
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });

    await expect(
      GridFSHelper.writeFileFromStream(bucket, exploding('client aborted'), { filename: `${marker}-helper.txt` }),
    ).rejects.toThrow('client aborted');
  });

  it('leaves no file document behind for the aborted upload', async () => {
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    const filename = `${marker}-orphan.txt`;

    await expect(GridFSHelper.writeFileFromStream(bucket, exploding('aborted'), { filename })).rejects.toThrow();

    // A files document whose chunks never completed would be served as a file that
    // exists and then fail mid-download; the write is aborted instead.
    expect(await connection.db.collection('fs.files').find({ filename }).toArray()).toHaveLength(0);
  });

  it('answers the same way under every driver', async () => {
    // The property is that the ANSWER does not depend on `file.storage`: a failed
    // upload is a rejected promise, never a process-level event.
    const drivers: { config: Record<string, any>; driver: string }[] = [
      { config: { storage: 'gridfs' }, driver: 'gridfs' },
      { config: { storage: 'filesystem', storageDir: directory }, driver: 'filesystem' },
    ];

    for (const { config, driver } of drivers) {
      ConfigService.setConfig({ ...(previousConfig as any), file: config } as IServerOptions, { reInit: true });
      const service = new TestFileService(connection);

      await expect(
        service.createFile({
          createReadStream: () => exploding(`aborted on ${driver}`),
          filename: `${marker}-${driver}.txt`,
          mimetype: 'text/plain',
        }),
      ).rejects.toThrow(/aborted on|exploded|requires either/);

      expect(await service.getFileInfoByName(`${marker}-${driver}.txt`)).toBeNull();
    }
  });
});

/**
 * The same question for the S3 driver's own streaming paths.
 *
 * Nothing on the S3 path buffers an upload any more, so both ways a stream reaches S3 are covered:
 *
 * - KNOWN length (tus finalization, `size` on `createFile()`): the stream goes straight into one
 *   PutObject — exactly the shape the AWS SDK pipes into its HTTP request without listening on the
 *   source. A staged read that dropped mid-migration therefore ended the process, the same way
 *   GridFS did.
 * - UNKNOWN length (every GraphQL and streamed REST upload): a multipart upload via
 *   `@aws-sdk/lib-storage`, which does listen on the source. What has to hold there is that a
 *   failure surfaces with its real cause AND aborts the parts already uploaded — S3 keeps (and
 *   bills) the parts of an incomplete multipart upload until something aborts it.
 *
 * @regression   11.33.1 — CoreS3Service.putObject() handed a known-length body stream straight to
 *   the AWS SDK, which does not listen on the SOURCE, so a failing body was an uncaught exception.
 * @seen-failing Registered as mutation `s3-body-stream-error-unguarded` in
 *   tests/regression-mutations.json.
 */
describe('S3 upload with a failing source stream (e2e)', () => {
  const bucket = `nest-server-s3-stream-err-${Date.now()}-p${process.pid}`;
  const s3Config = {
    accessKeyId: process.env.S3_ACCESS_KEY || 'rustfs',
    autoCreateBucket: true,
    bucket,
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9102',
    forcePathStyle: true,
    region: 'us-east-1',
    secretAccessKey: process.env.S3_SECRET_KEY || 'rustfs-secret',
  };

  let connection: Connection;
  let s3Service: CoreS3Service;
  let collection: any;
  let previousConfig: Partial<IServerOptions>;
  const marker = `s3-stream-error-${Date.now()}-p${process.pid}`;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    ConfigService.setConfig(
      { ...(previousConfig as any), file: { storage: 's3' }, s3: s3Config } as IServerOptions,
      { reInit: true },
    );
    const configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });
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
    collection = connection.db.collection(S3_FILES_COLLECTION);
  }, 60_000);

  afterAll(async () => {
    await collection?.deleteMany({ filename: { $regex: marker } });
    await dropS3Buckets(s3Service?.getClient(), [bucket]);
    await s3Service?.onApplicationShutdown();
    await connection?.close();
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 60_000);

  it('rejects with the REAL cause when a known-length body stream fails immediately', async () => {
    const filename = `${marker}-immediate.bin`;

    // The cause, not the SDK's `socket hang up`: without it an operator sees a transport error for
    // what is actually a broken source, and the guard would be indistinguishable from no guard.
    await expect(
      S3FileHelper.writeFile(s3Service, collection, { body: exploding('source blew up'), contentLength: 1024, filename }),
    ).rejects.toThrow('source blew up');

    expect(await collection.countDocuments({ filename })).toBe(0);
  }, 60_000);

  it('rejects with the REAL cause when the body stream drops MID-transfer', async () => {
    const filename = `${marker}-mid.bin`;
    let reads = 0;
    const midFail = new Readable({
      read() {
        if (reads++ < 2) {
          this.push(Buffer.alloc(1024, 'x'));
        } else {
          this.destroy(new Error('dropped mid-transfer'));
        }
      },
    });

    await expect(
      S3FileHelper.writeFile(s3Service, collection, { body: midFail, contentLength: 10 * 1024, filename }),
    ).rejects.toThrow('dropped mid-transfer');

    expect(await collection.countDocuments({ filename })).toBe(0);
  }, 60_000);

  it('rejects with the REAL cause when an UNKNOWN-length stream drops after the first part — and leaves no parts behind', async () => {
    const filename = `${marker}-multipart-mid.bin`;
    let sent = 0;
    // More than one 5 MiB part, so the multipart upload has really been created when it fails.
    const midFail = new Readable({
      read() {
        if (sent < 6 * 1024 * 1024) {
          sent += 256 * 1024;
          this.push(Buffer.alloc(256 * 1024, 'y'));
        } else {
          this.destroy(new Error('dropped mid-multipart'));
        }
      },
    });

    await expect(S3FileHelper.writeFile(s3Service, collection, { body: midFail, filename })).rejects.toThrow(
      'dropped mid-multipart',
    );

    expect(await collection.countDocuments({ filename })).toBe(0);
    const pending = await s3Service.getClient().send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    expect(pending.Uploads ?? [], 'the parts of the failed upload must have been aborted').toHaveLength(0);
  }, 60_000);

  it('still uploads a healthy UNKNOWN-length stream — in parts, with the size S3 stored', async () => {
    // The paired control for the case above, and the proof that the real `@aws-sdk/lib-storage`
    // path runs against a real store: the spy shows the multipart branch was taken.
    const filename = `${marker}-multipart-healthy.bin`;
    const multipart = vi.spyOn(s3Service as any, 'putObjectMultipart');
    const size = 6 * 1024 * 1024 + 1;

    const info = await S3FileHelper.writeFile(s3Service, collection, {
      body: Readable.from([Buffer.alloc(size - 1, 'z'), Buffer.from('!')]),
      filename,
    });

    expect(multipart).toHaveBeenCalledTimes(1);
    expect(info.length).toBe(size);
    expect((await s3Service.statObject(info._id.toHexString()))?.contentLength).toBe(size);
    multipart.mockRestore();
  }, 60_000);

  it('still uploads a healthy known-length stream', async () => {
    // Keeps the two cases above from passing because streaming to S3 is broken outright.
    const filename = `${marker}-healthy.txt`;

    const info = await S3FileHelper.writeFile(s3Service, collection, {
      body: Readable.from([Buffer.from('healthy')]),
      contentLength: 7,
      contentType: 'text/plain',
      filename,
    });

    expect(info.length).toBe(7);
    expect(await s3Service.objectExists(info._id.toHexString())).toBe(true);
  }, 60_000);
});
