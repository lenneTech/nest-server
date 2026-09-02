/**
 * Browser security headers, asserted on a real response.
 *
 * WHY AN E2E AND NOT A UNIT TEST
 *
 * The two properties that actually matter are about POSITION in the request pipeline, and a unit
 * test of the middleware cannot see either:
 *
 * 1. **A rejected request carries them too.** The headers are registered as middleware precisely
 *    so a `401` from a roles guard is covered — those are the responses an attacker generates
 *    most of. An interceptor would have missed every one of them, and would have unit-tested just
 *    as green.
 * 2. **HSTS follows the protocol, never configuration.** A browser REMEMBERS
 *    `Strict-Transport-Security`. One sent from a dev server over `http://localhost` makes every
 *    project on that host unreachable over http for up to a year, and nothing on the server can
 *    take it back. So the plain-http case must be asserted against a real request, not against a
 *    config object.
 *
 * @regression   11.38.0 — nest-server set no security headers at all. Projects across the stack
 *   were rebuilding the same set by hand (one inline in `main.ts`, one as its own middleware) and
 *   a freshly generated project sent none, so an omission produced no error anywhere and surfaced
 *   in a pentest months later.
 * @seen-failing Two registered mutations in tests/regression-mutations.json:
 *   `security-headers-disabled-by-default` makes the middleware inert unless explicitly enabled
 *   (the safe-default half), and `security-headers-hsts-ignores-protocol` sends HSTS regardless of
 *   protocol (the localhost-poisoning half).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HttpExceptionLogFilter } from '../src';
import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';

describe('Security headers', () => {
  let app: any;

  /** Raw headers of a GET, without asserting the status — the point is what comes back with it. */
  const headersOf = async (path: string): Promise<Record<string, string>> => {
    const request = (await import('supertest')).default;
    const response = await request(app.getHttpServer()).get(path);
    return response.headers as Record<string, string>;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sets the safe defaults without any configuration', async () => {
    // `src/config.env.ts` configures no `security.headers` block at all, so this is the
    // unconfigured path — the one a project gets by upgrading and doing nothing.
    const headers = await headersOf('/health-check');

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('removes the X-Powered-By banner', async () => {
    const headers = await headersOf('/health-check');

    expect(headers['x-powered-by'], 'naming the stack helps an attacker and nobody else').toBeUndefined();
  });

  it('ships no Content-Security-Policy by default', async () => {
    // Deliberate. A CSP that does not match what the app loads breaks it rather than hardening
    // it, and this package cannot know that — it even serves its own HTML from the Hub and the
    // GraphQL playground. Shipping a default here would be a guess with a blast radius.
    const headers = await headersOf('/health-check');

    expect(headers['content-security-policy']).toBeUndefined();
  });

  it('does NOT send HSTS over plain http', async () => {
    // The one that cannot be undone. A browser remembers this header, so sending it from a dev
    // server would make every project on localhost unreachable over http for up to a year.
    const headers = await headersOf('/health-check');

    expect(
      headers['strict-transport-security'],
      'HSTS on a plain-http request poisons the host for every other project on it',
    ).toBeUndefined();
  });

  it('sends HSTS when the request arrived over https', async () => {
    const request = (await import('supertest')).default;

    // What a TLS-terminating proxy puts on the request. The connection reaching Node is still
    // plain http, which is exactly why the forwarded header has to be consulted first.
    const response = await request(app.getHttpServer()).get('/health-check').set('x-forwarded-proto', 'https');

    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(response.headers['strict-transport-security']).toContain('includeSubDomains');
    // `preload` commits every subdomain to a browser-vendor list that is awkward to reverse —
    // that belongs to whoever owns the domain, not to a framework default.
    expect(response.headers['strict-transport-security']).not.toContain('preload');
  });

  it('reads only the client-facing hop of a forwarded proto chain', async () => {
    const request = (await import('supertest')).default;

    // A proxy chain appends: the browser spoke https to the edge, the edge spoke http inward.
    // The first entry is the one that describes the browser's connection.
    const secure = await request(app.getHttpServer()).get('/health-check').set('x-forwarded-proto', 'https,http');
    expect(secure.headers['strict-transport-security']).toBeDefined();

    const insecure = await request(app.getHttpServer()).get('/health-check').set('x-forwarded-proto', 'http,https');
    expect(insecure.headers['strict-transport-security']).toBeUndefined();
  });

  it('sets the headers on a response a guard REJECTED', async () => {
    // The reason this is middleware and not an interceptor. `/config` requires ADMIN, so an
    // anonymous request is turned away before any handler runs — and that response still has to
    // carry the headers. An interceptor would never have run here.
    const request = (await import('supertest')).default;
    const raw = await request(app.getHttpServer()).get('/config');

    expect(raw.status, 'precondition: /config must be guarded').toBe(401);
    expect(raw.headers['x-content-type-options'], 'a rejected request is still a response a browser renders').toBe(
      'nosniff',
    );
    expect(raw.headers['x-frame-options']).toBe('DENY');
  });
});
