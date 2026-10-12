import * as http from 'http';
import mongoose, { Connection } from 'mongoose';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreFileService } from '../src/core/modules/file/core-file.service';
import { FILESYSTEM_FILES_COLLECTION } from '../src/core/modules/file/filesystem-file.helper';
import { CoreTusService } from '../src/core/modules/tus/core-tus.service';
import { TUS_FILE_ID_HEADER } from '../src/core/modules/tus/tus.constants';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';

/**
 * The finished tus upload tells the client the ID of the file it became.
 *
 * Until 11.42.13 `onUploadComplete()` held the stored file's `_id` in every one of its paths and
 * dropped it, and `onUploadFinish` answered `{}`. The client therefore knew only the TUS URL, whose
 * last segment is the TUS UPLOAD id — a key of the staging store, not of the file store. A consumer
 * that took it for the file id (the obvious reading) linked `/files/id/<upload-id>`, which answers
 * 404 for every upload.
 *
 * Since then the response that completes the upload — the last PATCH, or the POST of a
 * creation-with-upload — carries `X-File-Id`, and the header is listed in
 * `Access-Control-Expose-Headers`, without which a browser on a separate app origin cannot read it.
 *
 * The cases assert against the file store itself (`CoreFileService`, the same service the download
 * routes use), so "a header is there" cannot pass for "the header names the stored file".
 *
 * `onUploadComplete()` keeps its `Promise<void>` signature; the id is recorded on the side. Both
 * override shapes the docs show — `await super.onUploadComplete(upload)` and
 * `return super.onUploadComplete(upload)` — therefore compile unchanged (pinned by `typecheck:tests`,
 * which compiles this file) and still yield the header. A first draft returned the id instead: the
 * second shape stopped compiling, and the first silently lost the header in every project that had
 * followed the docs.
 *
 * @regression   11.42.13 — a finished tus upload answered without the ID of the stored file, so a
 *   client could only guess it from the TUS URL, and `/files/id/<tus-upload-id>` answered 404.
 * @seen-failing Make `onUploadFinish` in src/core/modules/tus/core-tus.service.ts answer `{}` again, or
 *   drop `exposedHeaders` from the tus server options — registered as mutations `tus-file-id-dropped`
 *   and `tus-file-id-not-exposed` in tests/regression-mutations.json.
 */
describe('TUS answers the ID of the stored file (e2e)', () => {
  let connection: Connection;
  let previousConfig: Partial<IServerOptions>;
  let fixtureDir: string;
  let started: { close: () => Promise<void>; url: string } | undefined;

  const testId = `tus-file-id-${Date.now()}-p${process.pid}`;
  const APP = 'https://app.example.com';
  const API = 'https://api.example.com';
  const USER_ID = '6a0000000000000000000f11';

  class TestFileService extends CoreFileService {
    constructor(conn: Connection, configService: ConfigService) {
      super(conn, 'fs', { configService });
    }
  }

  /** The override shape the README documented before 11.42.13: `await super`, no return value. */
  class AwaitingSuperTusService extends CoreTusService {
    protected override async onUploadComplete(upload: any): Promise<void> {
      await super.onUploadComplete(upload);
    }
  }

  /** The tail-return shape the framework documents for the sibling hook `onUploadCreate`. */
  class ReturningSuperTusService extends CoreTusService {
    protected override async onUploadComplete(upload: any): Promise<void> {
      return super.onUploadComplete(upload);
    }
  }

  /** An override that replaces the storage step entirely: nothing is stored by the core. */
  class SkippingSuperTusService extends CoreTusService {
    protected override async onUploadComplete(): Promise<void> {
      // a project that hands the bytes to its own store; nothing reaches the file module
    }
  }

  /** A tus service under `config`, behind a plain HTTP server that plays the role guard. */
  const start = async (
    config: Partial<IServerOptions>,
    TusService: typeof CoreTusService = CoreTusService,
  ): Promise<ConfigService> => {
    ConfigService.setConfig({ ...(previousConfig as any), ...config } as IServerOptions, { reInit: true });
    const configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });
    const tusService = new TusService(connection, { configService });
    tusService.configure({ uploadDir: path.join(fixtureDir, `tus-${Math.random().toString(36).slice(2)}`) });
    await tusService.onModuleInit();
    const server = http.createServer((req, res) => {
      (req as any).user = { id: USER_ID, roles: [] };
      void tusService.getServer().handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    started = {
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await tusService.onModuleDestroy();
      },
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    };
    return configService;
  };

  const tusRequest = (options: {
    body?: Buffer;
    headers?: Record<string, string>;
    method: string;
    path: string;
  }): Promise<{ headers: http.IncomingHttpHeaders; statusCode: number }> =>
    new Promise((resolve, reject) => {
      const { port } = new URL(started!.url);
      const req = http.request(
        {
          headers: { Origin: APP, 'Tus-Resumable': '1.0.0', ...options.headers },
          hostname: '127.0.0.1',
          method: options.method,
          path: options.path,
          port,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ headers: res.headers, statusCode: res.statusCode as number }));
        },
      );
      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });

  const metadataFor = (filename: string): string =>
    `filename ${Buffer.from(filename).toString('base64')},filetype ${Buffer.from('text/plain').toString('base64')}`;

  /** POST, then the given PATCH chunks in order; returns every response. */
  const upload = async (filename: string, chunks: Buffer[]) => {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const created = await tusRequest({
      headers: { 'Upload-Length': String(length), 'Upload-Metadata': metadataFor(filename) },
      method: 'POST',
      path: '/tus',
    });
    expect(created.statusCode, 'tus creation').toBe(201);
    const uploadId = (created.headers.location as string).split('/').pop() as string;

    const patches: { headers: http.IncomingHttpHeaders; statusCode: number }[] = [];
    let offset = 0;
    for (const chunk of chunks) {
      const patched = await tusRequest({
        body: chunk,
        headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) },
        method: 'PATCH',
        path: `/tus/${uploadId}`,
      });
      expect(patched.statusCode, 'tus patch').toBe(204);
      offset += chunk.length;
      patches.push(patched);
    }
    return { created, patches, uploadId };
  };

  /** Cookie authentication with split app and API origins — where the header must be exposed. */
  const splitOrigins = { appUrl: APP, baseUrl: API, cookies: true, cors: {} } as Partial<IServerOptions>;

  beforeAll(async () => {
    previousConfig = { ...(envConfig as Partial<IServerOptions>) };
    fixtureDir = await createFixtureDir(testId);
    connection = (await mongoose.createConnection(process.env.MONGODB_URI).asPromise()) as any;
  }, 120_000);

  afterEach(async () => {
    await started?.close();
    started = undefined;
  });

  afterAll(async () => {
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    for (const doc of await connection.db.collection('fs.files').find({ filename: { $regex: testId } }).toArray()) {
      await bucket.delete(doc._id).catch(() => undefined);
    }
    await connection.db.collection(FILESYSTEM_FILES_COLLECTION).deleteMany({ filename: { $regex: testId } });
    await connection?.close();
    await removeFixtureDir(fixtureDir);
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 120_000);

  it('answers the completing PATCH with the ID of the file in GridFS', async () => {
    const configService = await start({ ...splitOrigins, file: { storage: 'gridfs' } } as Partial<IServerOptions>);
    const filename = `${testId}-gridfs.txt`;
    const payload = Buffer.from('finished upload, stored in gridfs');

    const { patches, uploadId } = await upload(filename, [payload]);
    const fileId = patches[0].headers[TUS_FILE_ID_HEADER.toLowerCase()] as string;

    expect(fileId, 'the completing PATCH must name the stored file').toMatch(/^[0-9a-f]{24}$/);
    expect(fileId, 'the file id, not the staging key').not.toBe(uploadId);
    const fileService = new TestFileService(connection, configService);
    const info = await fileService.getFileInfo(fileId);
    expect(info?.filename).toBe(filename);
    expect((await fileService.getBuffer(fileId)).toString()).toBe(payload.toString());
  });

  it('exposes the header to a browser on a separate app origin', async () => {
    await start(splitOrigins);

    const { patches } = await upload(`${testId}-exposed.txt`, [Buffer.from('exposed')]);
    const exposed = String(patches[0].headers['access-control-expose-headers'] ?? '')
      .split(',')
      .map((header) => header.trim().toLowerCase());

    expect(exposed).toContain(TUS_FILE_ID_HEADER.toLowerCase());
    // Appended, not replacing what the tus protocol itself needs a browser to read.
    expect(exposed).toContain('upload-offset');
    expect(exposed).toContain('location');
  });

  it('names the file only on the request that completes the upload', async () => {
    await start(splitOrigins);

    const { created, patches } = await upload(`${testId}-chunked.txt`, [Buffer.from('first-'), Buffer.from('second')]);

    expect(created.headers[TUS_FILE_ID_HEADER.toLowerCase()], 'creation stores nothing yet').toBeUndefined();
    expect(patches[0].headers[TUS_FILE_ID_HEADER.toLowerCase()], 'a partial PATCH stores nothing yet').toBeUndefined();
    expect(patches[1].headers[TUS_FILE_ID_HEADER.toLowerCase()]).toMatch(/^[0-9a-f]{24}$/);
  });

  it('answers a creation-with-upload POST that completes in one request', async () => {
    const configService = await start(splitOrigins);
    const filename = `${testId}-one-request.txt`;
    const payload = Buffer.from('created and finished in one request');

    const created = await tusRequest({
      body: payload,
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Length': String(payload.length),
        'Upload-Metadata': metadataFor(filename),
      },
      method: 'POST',
      path: '/tus',
    });
    const fileId = created.headers[TUS_FILE_ID_HEADER.toLowerCase()] as string;

    expect(created.statusCode).toBe(201);
    expect(fileId).toMatch(/^[0-9a-f]{24}$/);
    expect((await new TestFileService(connection, configService).getFileInfo(fileId))?.filename).toBe(filename);
  });

  it('answers with the ID of the file on the filesystem driver', async () => {
    const storageDir = path.join(fixtureDir, 'filesystem-store');
    const configService = await start({
      ...splitOrigins,
      file: { storage: 'filesystem', storageDir },
    } as Partial<IServerOptions>);
    const filename = `${testId}-filesystem.txt`;
    const payload = Buffer.from('finished upload, stored on the filesystem');

    const { patches } = await upload(filename, [payload]);
    const fileId = patches[0].headers[TUS_FILE_ID_HEADER.toLowerCase()] as string;

    expect(fileId).toMatch(/^[0-9a-f]{24}$/);
    expect(await connection.db.collection(FILESYSTEM_FILES_COLLECTION).findOne({ filename })).toBeTruthy();
    expect((await new TestFileService(connection, configService).getBuffer(fileId)).toString()).toBe(
      payload.toString(),
    );
  });

  it.each([
    ['await super.onUploadComplete(upload)', AwaitingSuperTusService],
    ['return super.onUploadComplete(upload)', ReturningSuperTusService],
  ])('answers with the file ID through a project override that calls %s', async (_shape, TusService) => {
    const configService = await start(splitOrigins, TusService);
    const filename = `${testId}-override-${TusService.name}.txt`;

    const { patches } = await upload(filename, [Buffer.from('stored through a project override')]);
    const fileId = patches[0].headers[TUS_FILE_ID_HEADER.toLowerCase()] as string;

    expect(patches[0].statusCode).toBe(204);
    expect(fileId, 'an override in a documented shape must not lose the header').toMatch(/^[0-9a-f]{24}$/);
    expect((await new TestFileService(connection, configService).getFileInfo(fileId))?.filename).toBe(filename);
  });

  it('paired control: an override that never calls super completes without a header', async () => {
    await start(splitOrigins, SkippingSuperTusService);
    const filename = `${testId}-skipping-override.txt`;

    const { patches } = await upload(filename, [Buffer.from('handed to a project store')]);

    expect(patches[0].statusCode).toBe(204);
    expect(patches[0].headers[TUS_FILE_ID_HEADER.toLowerCase()]).toBeUndefined();
    // Nothing reached the file module, so there is no id that could have been sent.
    expect(await connection.db.collection('fs.files').findOne({ filename })).toBeNull();
  });
});
