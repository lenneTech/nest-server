import compression = require('compression');
import * as http from 'http';
import mongoose, { Connection } from 'mongoose';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreTusService } from '../src/core/modules/tus/core-tus.service';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';

/**
 * A finished TUS upload behind the `compression` middleware.
 *
 * `@tus/server` answers the LAST `PATCH` with a bodyless 204 and closes it through srvx with
 * `res.end(callback)` — a documented Node signature. `compression` patches `res.end(chunk, encoding)`
 * and treats the first argument as a chunk unconditionally, so the callback reaches
 * `Buffer.byteLength()` / `Buffer.from()` and throws `ERR_INVALID_ARG_TYPE ... Received function`.
 *
 * The starter's `main.ts` (and so every generated project) registers `compression` with
 * `filter: () => true` and `threshold: 0`, which takes away the two checks that would otherwise skip
 * a 204. The failure is the nasty kind: the file is already migrated into the file store when the
 * response dies, the client never sees a 2xx, `tus-js-client` never fires `onSuccess`, and no log
 * names `compression`. A test that only CREATES an upload stays green — only the final PATCH reaches
 * the broken path, which is what these cases drive.
 *
 * @regression   11.42.2 — with `compression` registered the way the starter does it, every finished
 *   TUS upload hung without an answer although the file had been stored.
 * @seen-failing Make `normalizeEndCallback()` in src/core/modules/tus/core-tus.service.ts return
 *   without patching — registered as mutation `tus-end-callback-unnormalized` in
 *   tests/regression-mutations.json.
 */
describe('TUS behind compression (e2e)', () => {
  let connection: Connection;
  let previousConfig: Partial<IServerOptions>;
  let fixtureDir: string;
  let tusService: CoreTusService;
  let url: string;
  let closeServer: () => Promise<void>;

  const testId = `tus-gzip-${Date.now()}-p${process.pid}`;
  const USER = '6a0000000000000000000c33';

  /** The middleware as nest-server-starter's main.ts registers it. */
  const starterCompression = compression({ filter: () => true, threshold: 0 });

  const tusRequest = (options: {
    body?: Buffer;
    headers?: Record<string, string>;
    method: string;
    path: string;
  }): Promise<{ headers: http.IncomingHttpHeaders; statusCode: number }> =>
    new Promise((resolve, reject) => {
      const { port } = new URL(url);
      const req = http.request(
        {
          headers: { 'Accept-Encoding': 'gzip, deflate, br', 'Tus-Resumable': '1.0.0', ...options.headers },
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
      // Without the fix the final PATCH never answers. Fail in seconds rather than at the test timeout.
      req.setTimeout(15_000, () => req.destroy(new Error(`no answer to ${options.method} ${options.path}`)));
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });

  beforeAll(async () => {
    previousConfig = { ...(envConfig as Partial<IServerOptions>) };
    fixtureDir = await createFixtureDir(testId);
    ConfigService.setConfig({ ...(previousConfig as any), file: { storage: 'gridfs' } } as IServerOptions, {
      reInit: true,
    });
    const configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });
    connection = (await mongoose.createConnection(process.env.MONGODB_URI).asPromise()) as any;

    tusService = new CoreTusService(connection, { configService });
    tusService.configure({ uploadDir: path.join(fixtureDir, 'tus') });
    await tusService.onModuleInit();

    const server = http.createServer((req, res) => {
      starterCompression(req as any, res as any, () => {
        (req as any).user = { id: USER, roles: [] };
        void tusService.getServer().handle(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    closeServer = async () => {
      // A request left hanging by a regression would otherwise keep close() waiting for minutes.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tusService.onModuleDestroy();
    };
  }, 120_000);

  afterAll(async () => {
    await closeServer?.();
    await connection?.close();
    await removeFixtureDir(fixtureDir);
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 120_000);

  it('answers the final PATCH with 204 and stores the file', async () => {
    const filename = `${testId}-done.txt`;
    const payload = Buffer.from('compressed route, finished upload');

    const created = await tusRequest({
      headers: {
        'Upload-Length': String(payload.length),
        'Upload-Metadata': `filename ${Buffer.from(filename).toString('base64')}`,
      },
      method: 'POST',
      path: '/tus',
    });
    expect(created.statusCode, 'creation').toBe(201);
    const uploadId = (created.headers.location as string).split('/').pop() as string;

    const finished = await tusRequest({
      body: payload,
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      method: 'PATCH',
      path: `/tus/${uploadId}`,
    });

    expect(finished.statusCode, 'the final PATCH must reach the client as success').toBe(204);
    expect(finished.headers['upload-offset']).toBe(String(payload.length));
    const stored = await connection.db!.collection('fs.files').findOne({ filename });
    expect(stored, 'the upload was migrated into the file store').toBeTruthy();
  });

  it('answers an intermediate PATCH and a HEAD as well', async () => {
    const payload = Buffer.from('first half|second half');
    const created = await tusRequest({
      headers: {
        'Upload-Length': String(payload.length),
        'Upload-Metadata': `filename ${Buffer.from(`${testId}-parts.txt`).toString('base64')}`,
      },
      method: 'POST',
      path: '/tus',
    });
    const uploadId = (created.headers.location as string).split('/').pop() as string;

    const part = await tusRequest({
      body: payload.subarray(0, 10),
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      method: 'PATCH',
      path: `/tus/${uploadId}`,
    });
    expect(part.statusCode).toBe(204);

    const head = await tusRequest({ method: 'HEAD', path: `/tus/${uploadId}` });
    expect(head.statusCode).toBe(200);
    expect(head.headers['upload-offset']).toBe('10');
  });
});
