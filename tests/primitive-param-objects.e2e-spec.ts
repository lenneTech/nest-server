/**
 * A request value that is an object never reaches a primitive-typed parameter, and no non-string value stays in the
 * parsed cookies (DEV-4144) — the class of DEV-4138 (session cookie as an object) and DEV-4143 (reset token as an
 * object), closed for every route rather than per query.
 *
 * The suite boots the reference `ServerModule`, whose `UserController` has exactly the parameters DEV-4143 went
 * through (`@Body('token') token: string`, `@Body('email') email: string`), plus a test controller that echoes the
 * cookies a route sees after every middleware ran. cookie-parser is registered as `src/main.ts` does; a testing module
 * does not run `main.ts`, and without it there would be no `j:` object to remove.
 *
 * It runs on MongoDB, PostgreSQL and MySQL / MariaDB (`IAM_SQL_TEST_INCLUDE`): on MySQL a number (`j:7`) is what an
 * object is on MongoDB, a value `token = 7` compares numerically.
 */
import { Controller, Get, Req } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { PubSub } from 'graphql-subscriptions';

import { HttpExceptionLogFilter, RoleEnum, Roles, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { resolveBetterAuthSessionCookieName } from '../src/core/modules/better-auth/better-auth-cookie-prefix.helper';
import { ServerModule } from '../src/server/server.module';
import { type IamTestDb, openIamTestDb } from './helpers/iam-test-db';

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
  let testHelper: TestHelper;
  let iamDb: IamTestDb;
  const sessionCookie = resolveBetterAuthSessionCookieName('iam');
  const user = { id: '', sessionToken: '' };

  /** `<name>=j:<json>` as a browser or curl would send it */
  const jsonCookie = (name: string, value: unknown) => `${name}=${encodeURIComponent(`j:${JSON.stringify(value)}`)}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
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
    testHelper = new TestHelper(app);
    iamDb = await openIamTestDb(envConfig.mongoose.uri);

    const email = `primitive-param-objects-${Date.now()}-${Math.random().toString(36).substring(7)}@test.com`;
    const password = 'PrimitiveParams123!';
    const signedUp: any = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Primitive Params', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    user.id = signedUp.user.id;
    await testHelper.rest('/iam/sign-in/email', { method: 'POST', payload: { email, password }, statusCode: 200 });
    user.sessionToken = (await iamDb.latestSessionToken(user.id)) ?? '';
    expect(user.sessionToken).toBeTruthy();
  });

  afterAll(async () => {
    if (iamDb) {
      await iamDb.deleteUsers({ ids: user.id ? [user.id] : [] });
      await iamDb.close();
    }
    if (app) {
      await app.close();
    }
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
    const response: any = await testHelper.rest(url, { method: 'POST', payload, statusCode: 400 });

    expect(JSON.stringify(response)).toContain('LTNS_0306');
  });

  it('paired control: a string still reaches the service, and a repeated query key (an array) is not refused', async () => {
    await testHelper.rest('/users/password/reset', {
      method: 'POST',
      payload: { password: 'Whatever123!', token: 'not-a-live-token' },
      statusCode: 404,
    });
    const verified = await testHelper.rest('/users/verified-state?token=a&token=b', { statusCode: 200 });
    expect(verified).toBe(false);
  });

  /**
   * @regression   DEV-4144 — cookie-parser turned a `j:` cookie into an object (or, `j:7`, a number) in
   *   `req.cookies`, and every reader downstream had to guard against it on its own (DEV-4138).
   * @seen-failing Remove `consumer.apply(StringCookiesMiddleware).forRoutes('*')` from CoreModule.configure() in
   *   src/core.module.ts — registered as mutation `string-cookies-middleware-not-registered` in
   *   tests/regression-mutations.json.
   */
  it('lets no non-string cookie through to a route — object, number, boolean or array', async () => {
    const cookies = await testHelper.rest('/test-cookie-echo', {
      cookies: [
        jsonCookie(sessionCookie, { $ne: null }),
        jsonCookie('token', 7),
        jsonCookie('flag', true),
        jsonCookie('list', ['a']),
        'plain=abc',
      ].join('; '),
      statusCode: 200,
    });

    expect(cookies).toEqual([{ name: 'plain', type: 'string' }]);
  });

  it('answers 401 to a `j:` session cookie — an operator, and the live token as a number for MySQL', async () => {
    const numericTwin = Number.parseFloat(user.sessionToken) || 0;
    for (const value of [{ $ne: null }, { $in: [user.sessionToken] }, numericTwin]) {
      await testHelper.rest(`/users/${user.id}`, { cookies: jsonCookie(sessionCookie, value), statusCode: 401 });
    }
    // Paired control: the live session token as a string cookie still signs in
    await testHelper.rest(`/users/${user.id}`, { cookies: user.sessionToken, statusCode: 200 });
  });
});
