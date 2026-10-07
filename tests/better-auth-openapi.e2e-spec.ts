import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import http from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { buildSwaggerDocument } from '../src/core/common/helpers/swagger.helper';
import { CoreBetterAuthService } from '../src/core/modules/better-auth/core-better-auth.service';
import { ServerModule } from '../src/server/server.module';

import type { OperationObject } from '@nestjs/swagger';
import type { AddressInfo } from 'node:net';

/**
 * Better-Auth's openAPI() plugin is registered by nest-server only so setupSwagger() can document the
 * routes Better-Auth serves itself. Against the assembled ServerModule this pins both halves: the
 * description reaches the Swagger document, and the plugin's own routes stay out of the public API —
 * while every other Better-Auth route is still forwarded.
 */
describe('Better-Auth routes in the Swagger document', () => {
  let app: NestExpressApplication;
  let port: number;

  /** A request with its path exactly as given: supertest and fetch remove dot segments before sending. */
  function raw(path: string): Promise<{ body: string; status: number }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', method: 'GET', path, port }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ body, status: res.statusCode ?? 0 }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    await app.init();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    const server = app?.getHttpServer();
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await app?.close();
  });

  /**
   * @regression   11.42.9 (pre-release review) — the plugin's routes were refused by a path check on the
   *   request as SENT, while Better-Auth matches the path after `new URL()` removed dot segments: an
   *   anonymous `GET /iam/./open-api/generate-schema` answered with Better-Auth's full schema, on every
   *   deployment, Swagger or not.
   * @seen-failing Register the plugin without serverOnlyPlugin() in buildPlugins()
   *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
   *   `openapi-plugin-routable` in tests/regression-mutations.json.
   */
  it.each([
    '/iam/open-api/generate-schema',
    '/iam/./open-api/generate-schema',
    '/iam/%2e/open-api/generate-schema',
    '/iam/x/../open-api/generate-schema',
    '/iam/x/%2e%2e/open-api/generate-schema',
    '/iam/sign-in/email/../../open-api/generate-schema',
    '/iam/session/%2e%2e/open-api/generate-schema',
  ])("keeps the openAPI() plugin's schema route off the router: %s", async (path) => {
    const response = await raw(path);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('openapi');
  });

  it("answers 404 for the openAPI() plugin's reference page", async () => {
    expect((await raw('/iam/reference')).status).toBe(404);
    expect((await raw('/iam/./reference')).status).toBe(404);
  });

  it('still forwards every other Better-Auth route', async () => {
    const ok = await request(app.getHttpServer()).get('/iam/ok');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
  });

  it('prepares the description at bootstrap and documents the routes Better-Auth serves itself', () => {
    expect(app.get(CoreBetterAuthService).getOpenApiSchema()?.paths).toBeDefined();

    const document = buildSwaggerDocument(app, { title: 'E2E' });
    const paths = Object.keys(document.paths);
    for (const path of ['/iam/get-session', '/iam/change-password', '/iam/two-factor/enable']) {
      expect(paths, path).toContain(path);
    }
    expect(paths).not.toContain('/iam/{path}');
    expect(paths.some((path) => path.startsWith('/iam/open-api'))).toBe(false);
    // The explicit controller route, not a generated duplicate.
    expect((document.paths['/iam/sign-in/email'].post as OperationObject).operationId).toMatch(/_signIn$/);
  });

  /**
   * @regression   11.42.9 — every route Better-Auth serves itself was documented as authenticated,
   *   sign-in, password reset and get-session included, because its generator marks all of them
   *   bearer-only; a generated client attached credentials it did not have to every public call.
   * @seen-failing Keep the generator's security on public operations in prepareOpenApiSchema()
   *   (src/core/modules/better-auth/core-better-auth.service.ts) — registered as mutation
   *   `better-auth-public-routes-unlabeled` in tests/regression-mutations.json.
   */
  it('documents a route as public exactly when Better-Auth serves it without a session', () => {
    const document = buildSwaggerDocument(app, { title: 'E2E' });
    const operation = (path: string, method: string) =>
      (document.paths[path] as Record<string, OperationObject> | undefined)?.[method];
    expect(operation('/iam/request-password-reset', 'post')?.security).toEqual([]);
    expect(operation('/iam/get-session', 'get')?.security).toEqual([]);
    // Session routes carry no own requirement: the document's global one (bearer or session cookie).
    expect(operation('/iam/list-sessions', 'get')?.security).toBeUndefined();
    expect(operation('/iam/two-factor/enable', 'post')?.security).toBeUndefined();
    expect(document.security?.length).toBeGreaterThan(0);
  });

  it('documents only what the running options let succeed', async () => {
    const document = buildSwaggerDocument(app, { title: 'E2E' });
    // Better-Auth's generator lists POST /get-session, but without session.deferSessionRefresh Better-Auth
    // answers 405 to everybody — so it is not documented, while GET is.
    expect(Object.keys(document.paths['/iam/get-session'])).toEqual(['get']);
    const post = await request(app.getHttpServer()).post('/iam/get-session').send({});
    expect(post.status).toBe(405);
  });
});
