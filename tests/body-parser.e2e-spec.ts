/**
 * The body-parser 413 on the ASSEMBLED stack.
 *
 * WHY AN E2E NEXT TO tests/unit/body-parser.spec.ts
 *
 * The unit spec proves the initializer against a hand-built module. Two things only the real
 * `ServerModule` can show:
 *
 * 1. **`CoreModule` actually registers it.** Remove the provider from `core.module.ts` and every
 *    unit case stays green while no project gets the behaviour.
 * 2. **GraphQL goes through the same parser.** Apollo registers no body parser of its own; it reads
 *    the body the global one produced. That is why `bodyParser.json.limit` governs GraphQL too — and
 *    a GraphQL client hitting the limit gets the same answer as a REST client.
 *
 * `src/config.env.ts` configures no `bodyParser`, so this is the path a project gets by upgrading
 * and doing nothing: the 100 kB default, now with an answer that says what happened.
 *
 * @regression   11.42.4 — body-parser's 100 kB default was the only limit in force and nobody had
 *   chosen it. Over it, a client got a bare "request entity too large" before auth and routing, and
 *   the log said nothing about which setting to change (DEV-3422: a document save failing on every
 *   retry).
 * @seen-failing Drop `CoreBodyParserInitializer` from the CoreModule providers — registered as
 *   mutation `body-parser-initializer-unregistered` in tests/regression-mutations.json.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';

const DEFAULT_LIMIT = 100 * 1024;

describe('Body parser limit (assembled stack)', () => {
  let app: any;

  /** A GraphQL request whose JSON body is padded to `bytes` through an unused variable */
  const graphQlBodyOfSize = (bytes: number): string => {
    const envelope = JSON.stringify({ query: '{ __typename }', variables: { pad: '' } });
    return JSON.stringify({ query: '{ __typename }', variables: { pad: 'x'.repeat(bytes - envelope.length) } });
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers an oversized GraphQL request with the error code, size and limit', async () => {
    const body = graphQlBodyOfSize(DEFAULT_LIMIT + 1);

    const res = await request(app.getHttpServer()).post('/graphql').set('Content-Type', 'application/json').send(body);

    expect(res.status).toBe(413);
    expect(res.body.message).toBe(
      `#LTNS_0304: Request body too large [${DEFAULT_LIMIT + 1} bytes, limit ${DEFAULT_LIMIT} bytes]`,
    );
  });

  it('still serves a GraphQL request at the limit', async () => {
    const body = graphQlBodyOfSize(DEFAULT_LIMIT);

    const res = await request(app.getHttpServer()).post('/graphql').set('Content-Type', 'application/json').send(body);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ __typename: 'Query' });
  });

  it('refuses an oversized REST request before authentication and routing', async () => {
    // An unauthenticated sign-in: the parser runs before anything that could look at a session.
    const body = JSON.stringify({ email: 'nobody@test.com', password: 'x'.repeat(DEFAULT_LIMIT) });

    const res = await request(app.getHttpServer())
      .post('/iam/sign-in/email')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(413);
    expect(res.body.message).toContain('#LTNS_0304: Request body too large');
  });
});
