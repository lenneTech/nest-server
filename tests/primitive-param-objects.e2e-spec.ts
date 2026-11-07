/**
 * A request value that is an object never reaches a primitive-typed parameter, and no non-string value stays in the
 * parsed cookies (DEV-4144) — the class of DEV-4138 (session cookie as an object) and DEV-4143 (reset token as an
 * object), closed for every route rather than per query.
 *
 * The suite boots the reference `ServerModule`, whose `UserController` has exactly the parameters DEV-4143 went
 * through (`@Body('token') token: string`, `@Body('email') email: string`), plus a test controller that echoes the
 * cookies a route sees after every middleware ran. cookie-parser is registered as `src/main.ts` does; a testing module
 * does not run `main.ts`, and without it there would be no `j:` object to remove.
 */
import { Controller, Get, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser = require('cookie-parser');
import { PubSub } from 'graphql-subscriptions';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter, RoleEnum, Roles } from '../src';
import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';

/** Which cookies a route sees once every middleware ran: name and type only, never the value */
@Controller('test-cookie-echo')
class CookieEchoController {
  @Get()
  @Roles(RoleEnum.S_EVERYONE)
  echo(@Req() req: any): { name: string; type: string }[] {
    return Object.entries(req.cookies ?? {}).map(([name, value]) => ({ name, type: typeof value }));
  }
}

describe('DEV-4144: objects never reach primitive parameters or the parsed cookies', () => {
  let app: any;
  let server: any;
  let mongo: MongoClient;
  let sessionCookie: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `primitive-param-objects-${stamp}@test.com`;
  const password = 'PrimitiveParams123!';
  const user = { cookie: '', id: '', sessionToken: '' };

  /** `<name>=j:<json>` as a browser or curl would send it */
  const jsonCookie = (name: string, value: unknown) => `${name}=${encodeURIComponent(`j:${JSON.stringify(value)}`)}`;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [CookieEchoController],
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    // As src/main.ts registers it
    const cookieSecret = (envConfig as any).jwt?.secret || (envConfig as any).betterAuth?.secret;
    app.use(cookieSecret ? cookieParser(cookieSecret) : cookieParser());
    await app.init();
    server = app.getHttpServer();
    sessionCookie = moduleFixture.get(CoreBetterAuthService).getSessionCookieName();
    mongo = await MongoClient.connect(envConfig.mongoose.uri);

    const signedUp = await request(server)
      .post('/iam/sign-up/email')
      .send({ email, name: 'Primitive Params', password, termsAndPrivacyAccepted: true })
      .expect(201);
    user.id = signedUp.body.user.id;
    const signedIn = await request(server).post('/iam/sign-in/email').send({ email, password }).expect(200);
    const setCookie = ([] as string[])
      .concat(signedIn.headers['set-cookie'] ?? [])
      .find((header) => header.startsWith(`${sessionCookie}=`));
    expect(setCookie, 'sign-in sets the session cookie').toBeDefined();
    const value = setCookie!.split(';')[0].slice(sessionCookie.length + 1);
    user.cookie = `${sessionCookie}=${value}`;
    user.sessionToken = decodeURIComponent(value).split('.')[0];
  });

  afterAll(async () => {
    if (mongo) {
      const users = await mongo.db().collection('users').find({ email }).toArray();
      const ids = users.flatMap((doc) => [doc._id, String(doc._id), ...(doc.iamId ? [doc.iamId] : [])]);
      for (const collection of ['session', 'account']) {
        await mongo
          .db()
          .collection(collection)
          .deleteMany({ userId: { $in: ids } });
      }
      await mongo.db().collection('users').deleteMany({ email });
      await mongo.close();
    }
    await app?.close();
  });

  /**
   * @regression   DEV-4144 — a JSON object for `@Body('token') token: string` passed MapAndValidatePipe unchecked and
   *   reached the service as a MongoDB operator (DEV-4143: `{"token":{"$ne":null}}` set somebody else's password).
   * @seen-failing Drop the `receivesObjectForPrimitive(value, metadata)` check from MapAndValidatePipe.transform() in
   *   src/core/common/pipes/map-and-validate.pipe.ts — registered as mutation `primitive-param-object-reaches-route`
   *   in tests/regression-mutations.json.
   */
  it.each([
    ['POST /users/password/reset', '/users/password/reset', { password: 'Whatever123!', token: { $ne: null } }],
    ['POST /users/password/reset-request', '/users/password/reset-request', { email: { $ne: null } }],
    ['POST /users/verify', '/users/verify', { token: { $regex: '.' } }],
  ])('answers 400 (LTNS_0306) to an operator object at %s', async (_label, url, payload) => {
    const res = await request(server).post(url).send(payload).expect(400);

    expect(JSON.stringify(res.body)).toContain('LTNS_0306');
  });

  it('paired control: a string still reaches the service, and a repeated query key (an array) is not refused', async () => {
    await request(server)
      .post('/users/password/reset')
      .send({ password: 'Whatever123!', token: 'not-a-live-token' })
      .expect(404);
    const verified = await request(server).get('/users/verified-state?token=a&token=b').expect(200);
    expect(verified.text).toBe('false');
  });

  /**
   * @regression   DEV-4144 — cookie-parser turned a `j:` cookie into an object (or a number) in `req.cookies`, and
   *   every reader downstream had to guard against it on its own (DEV-4138).
   * @seen-failing Remove `consumer.apply(StringCookiesMiddleware).forRoutes('*')` from CoreModule.configure() in
   *   src/core.module.ts — registered as mutation `string-cookies-middleware-not-registered` in
   *   tests/regression-mutations.json.
   */
  it('lets no non-string cookie through to a route — object, number, boolean or array', async () => {
    const res = await request(server)
      .get('/test-cookie-echo')
      .set(
        'Cookie',
        [
          jsonCookie(sessionCookie, { $ne: null }),
          jsonCookie('token', 7),
          jsonCookie('flag', true),
          jsonCookie('list', ['a']),
          'plain=abc',
        ].join('; '),
      )
      .expect(200);

    expect(res.body).toEqual([{ name: 'plain', type: 'string' }]);
  });

  it('answers 401 to a `j:` session cookie holding an operator', async () => {
    for (const value of [{ $ne: null }, { $in: [user.sessionToken] }]) {
      await request(server).get(`/users/${user.id}`).set('Cookie', jsonCookie(sessionCookie, value)).expect(401);
    }
    // Paired control: the live session cookie still signs in
    await request(server).get(`/users/${user.id}`).set('Cookie', user.cookie).expect(200);
  });
});
