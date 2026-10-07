import * as http from 'http';
import mongoose, { Connection } from 'mongoose';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions, ITusConfig } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreTusService } from '../src/core/modules/tus/core-tus.service';
import { createFixtureDir, removeFixtureDir } from './helpers/tmp-fixtures';

/**
 * What the tus protocol actually offers under a configuration — against the real `CoreTusService`, the
 * real `@tus/server` and real HTTP.
 *
 * `@tus/server` consults none of the extension flags: the store advertises creation and termination
 * whatever is configured, and it serves POST and DELETE regardless. And it builds an upload's URL from
 * a configured path rather than from where the controller listens. Each server below is mounted under
 * a path the configuration does not name, the way a global prefix or a project controller puts it.
 */
describe('TUS protocol under configuration (e2e)', () => {
  let connection: Connection;
  let previousConfig: Partial<IServerOptions>;
  let fixtureDir: string;
  const servers: { close: () => Promise<void> }[] = [];
  const testId = `tus-proto-${Date.now()}-p${process.pid}`;

  /** A tus server answering below `mount`, with `config` applied. Returns its base URL. */
  async function startTus(config: ITusConfig, name: string): Promise<string> {
    const configService = new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false });
    const service = new CoreTusService(connection, { configService });
    service.configure({ ...config, uploadDir: path.join(fixtureDir, name) });
    await service.onModuleInit();
    const server = http.createServer((req, res) => {
      (req as any).user = { id: '6a0000000000000000000a11', roles: [] };
      void service.getServer().handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push({
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await service.onModuleDestroy();
      },
    });
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  function request(
    base: string,
    options: { headers?: Record<string, string>; method: string; path: string },
  ): Promise<{ headers: http.IncomingHttpHeaders; statusCode: number }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          headers: { 'Tus-Resumable': '1.0.0', ...options.headers },
          hostname: '127.0.0.1',
          method: options.method,
          path: options.path,
          port: new URL(base).port,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ headers: res.headers, statusCode: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  const create = (base: string, collection: string) =>
    request(base, {
      headers: {
        'Upload-Length': '5',
        'Upload-Metadata': `filename ${Buffer.from(`${testId}.txt`).toString('base64')}`,
      },
      method: 'POST',
      path: collection,
    });

  const extensionsOf = async (base: string, collection: string) =>
    String((await request(base, { method: 'OPTIONS', path: collection })).headers['tus-extension'] ?? '').split(',');

  beforeAll(async () => {
    previousConfig = { ...(envConfig as Partial<IServerOptions>) };
    fixtureDir = await createFixtureDir(testId);
    ConfigService.setConfig({ ...(previousConfig as any), file: { storage: 'gridfs' } } as IServerOptions, {
      reInit: true,
    });
    connection = (await mongoose.createConnection(process.env.MONGODB_URI).asPromise()) as any;
  }, 120_000);

  afterAll(async () => {
    for (const server of servers) {
      await server.close();
    }
    await connection?.close();
    await removeFixtureDir(fixtureDir);
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 120_000);

  /**
   * @regression   11.42.9 — an upload's URL was built from `tus.path`, not from where the endpoint
   *   listens. Under a global prefix, a URI version or a project controller's own route — or with a
   *   configured `path` the controller did not follow — the client was handed a URL on which every
   *   HEAD / PATCH answered 404, so no upload could ever be resumed.
   * @seen-failing Build the URL from `this.config.path` again in createTusServer()'s `generateUrl`
   *   (src/core/modules/tus/core-tus.service.ts) — registered as mutation `tus-location-from-config-path`
   *   in tests/regression-mutations.json.
   */
  it('hands out an upload URL where the upload was created, so it can be resumed', async () => {
    const base = await startTus({}, 'location');
    const created = await create(base, '/api/v1/uploads');
    expect(created.statusCode).toBe(201);

    const location = new URL(created.headers.location as string);
    expect(location.pathname).toMatch(/^\/api\/v1\/uploads\/[^/]+$/);

    const resumed = await request(base, { method: 'HEAD', path: location.pathname });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.headers['upload-offset']).toBe('0');
  });

  /**
   * @regression   11.42.9 (pre-release review) — behind a proxy that strips a prefix, `path` was set to
   *   the PUBLIC path, the only way uploads could resume before 11.42.9. Building the URL from the
   *   request alone handed out the internal path, which the client cannot reach.
   * @seen-failing Always return the request path from CoreTusService.uploadCollectionPath()
   *   (src/core/modules/tus/core-tus.service.ts) — registered as mutation `tus-proxy-public-path-ignored`
   *   in tests/regression-mutations.json.
   */
  it('hands out the public path when the configured path is the request path behind a stripped prefix', async () => {
    const base = await startTus({ path: '/files/tus' }, 'proxy');
    const created = await create(base, '/tus');
    expect(new URL(created.headers.location as string).pathname).toMatch(/^\/files\/tus\/[^/]+$/);
  });

  /**
   * @regression   11.42.9 (pre-release review) — the framework's own `generateUrl` overrode @tus/server's
   *   `relativeLocation`, so a project relying on relative upload URLs (a same-origin frontend proxy)
   *   silently got absolute URLs on the API origin again.
   * @seen-failing Ignore both relative settings in createTusServer()'s `generateUrl`
   *   (src/core/modules/tus/core-tus.service.ts) — registered as mutation `tus-relative-location-ignored`
   *   in tests/regression-mutations.json.
   */
  it('hands out a relative upload URL when relativeLocation is set', async () => {
    const base = await startTus({ relativeLocation: true }, 'relative');
    const created = await create(base, '/api/tus');
    expect(created.headers.location).toMatch(/^\/api\/tus\/[^/]+$/);
  });

  /**
   * @regression   11.42.9 — `termination: false` was a line in the boot log: the store kept advertising
   *   the extension and DELETE kept removing uploads.
   * @seen-failing Drop the `termination` entry from CoreTusService.disabledExtensions()
   *   (src/core/modules/tus/core-tus.service.ts) — registered as mutation `tus-termination-flag-ignored`
   *   in tests/regression-mutations.json.
   */
  it('refuses DELETE and stops advertising termination when it is switched off', async () => {
    const base = await startTus({ termination: false }, 'no-termination');
    expect(await extensionsOf(base, '/tus')).not.toContain('termination');

    const id = new URL((await create(base, '/tus')).headers.location as string).pathname;
    expect((await request(base, { method: 'DELETE', path: id })).statusCode).toBe(501);
    // Still there: HEAD reports the upload.
    expect((await request(base, { method: 'HEAD', path: id })).statusCode).toBe(200);
  });

  it('refuses creation when it is switched off, and keeps both extensions by default', async () => {
    const off = await startTus({ creation: false }, 'no-creation');
    expect(await extensionsOf(off, '/tus')).not.toContain('creation');
    expect((await create(off, '/tus')).statusCode).toBe(501);

    const defaults = await startTus({}, 'defaults');
    expect(await extensionsOf(defaults, '/tus')).toEqual(expect.arrayContaining(['creation', 'termination']));
    const id = new URL((await create(defaults, '/tus')).headers.location as string).pathname;
    expect((await request(defaults, { method: 'DELETE', path: id })).statusCode).toBe(204);
  });
});
