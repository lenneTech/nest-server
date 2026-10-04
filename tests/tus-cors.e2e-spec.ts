import * as http from 'http';
import mongoose, { Connection } from 'mongoose';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreTusService } from '../src/core/modules/tus/core-tus.service';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';

/**
 * CORS on the responses the tus handler writes itself.
 *
 * `@tus/server` answers `Access-Control-Allow-Origin: *` unless it is given `allowedOrigins`, and the
 * core gave it none. With cookie authentication and separate app and API origins — `lt dev up`
 * locally, `app.example.com` / `api.example.com` in production — the request is credentialed, the
 * API's CORS layer adds `Access-Control-Allow-Credentials: true`, and a browser refuses the wildcard
 * in that combination. Every browser upload failed, while the server answered 201.
 *
 * Nothing caught it: the preflight is answered by Nest's own CORS layer (correctly), a 401 never
 * reaches the tus handler, and the existing tus specs send no `Origin`. Only an AUTHENTICATED request
 * WITH an `Origin` reaches the header that matters — which is what these cases send.
 *
 * Since 11.42.1 the tus server takes its origins from `buildCorsConfig()`, the function REST, GraphQL
 * and Better-Auth already share; `tus.allowedOrigins` overrides. Without credentialed CORS configured
 * (cookies off, or no origin resolvable) the previous behaviour stays.
 *
 * @regression   11.42.1 — the tus handler answered a credentialed cross-origin request with
 *   `Access-Control-Allow-Origin: *`, which browsers refuse, so no browser upload with cookie
 *   authentication and split origins could succeed.
 * @seen-failing Make `resolveCorsOrigins()` return `undefined` in
 *   src/core/modules/tus/core-tus.service.ts — registered as mutation `tus-cors-wildcard` in
 *   tests/regression-mutations.json.
 */
describe('TUS CORS with credentials (e2e)', () => {
  let connection: Connection;
  let previousConfig: Partial<IServerOptions>;
  let fixtureDir: string;
  let started: { close: () => Promise<void>; url: string } | undefined;

  const testId = `tus-cors-${Date.now()}-p${process.pid}`;
  const APP = 'https://app.example.com';
  const API = 'https://api.example.com';

  /** A tus service under `config`, behind a plain HTTP server that plays the role guard. */
  const start = async (config: Partial<IServerOptions>, tus: Record<string, unknown> = {}) => {
    ConfigService.setConfig({ ...(previousConfig as any), ...config } as IServerOptions, { reInit: true });
    const configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });
    const tusService = new CoreTusService(connection, { configService });
    tusService.configure({ uploadDir: path.join(fixtureDir, `tus-${Math.random().toString(36).slice(2)}`), ...tus });
    await tusService.onModuleInit();
    const server = http.createServer((req, res) => {
      (req as any).user = { id: '6a0000000000000000000a11', roles: [] };
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
  };

  /** An authenticated tus creation request carrying `origin`. */
  const create = (origin: string): Promise<{ headers: http.IncomingHttpHeaders; statusCode: number }> =>
    new Promise((resolve, reject) => {
      const { port } = new URL(started!.url);
      const req = http.request(
        {
          headers: {
            Origin: origin,
            'Tus-Resumable': '1.0.0',
            'Upload-Length': '5',
            'Upload-Metadata': `filename ${Buffer.from(`${testId}.txt`).toString('base64')}`,
          },
          hostname: '127.0.0.1',
          method: 'POST',
          path: '/tus',
          port,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ headers: res.headers, statusCode: res.statusCode as number }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  /** Cookie authentication with split app and API origins — the setup the defect broke. */
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
    await connection?.close();
    await removeFixtureDir(fixtureDir);
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 120_000);

  it('mirrors the app origin instead of answering with the wildcard a browser refuses', async () => {
    await start(splitOrigins);

    const response = await create(APP);

    expect(response.statusCode).toBe(201);
    expect(response.headers['access-control-allow-origin']).toBe(APP);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not grant a foreign origin', async () => {
    await start(splitOrigins);

    const response = await create('https://evil.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('mirrors any origin under cors.allowAll, as the API CORS layer does', async () => {
    await start({ ...splitOrigins, cors: { allowAll: true } } as Partial<IServerOptions>);

    expect((await create('https://anything.example')).headers['access-control-allow-origin']).toBe(
      'https://anything.example',
    );
  });

  it('lets tus.allowedOrigins override the derived list', async () => {
    await start(splitOrigins, { allowedOrigins: ['https://uploads.example.com/'] });

    expect((await create('https://uploads.example.com')).headers['access-control-allow-origin']).toBe(
      'https://uploads.example.com',
    );
    expect((await create(APP)).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('paired control: without cookies (no credentialed CORS) the previous wildcard stays', async () => {
    await start({ ...splitOrigins, cookies: false } as Partial<IServerOptions>);

    expect((await create(APP)).headers['access-control-allow-origin']).toBe('*');
  });
});
