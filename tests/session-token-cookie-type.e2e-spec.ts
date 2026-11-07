/**
 * A session cookie that is not a string signs nobody in (DEV-4138).
 *
 * cookie-parser turns a cookie value starting with `j:` into the parsed JSON, so `iam.session_token=j:{"$ne":null}`
 * reaches `req.cookies` as an object. The middleware ignores it (it reads strings only), and the role guard's fallback
 * passed it through `extractTokenFromRequest()` to `getSessionByToken()`, whose `{ $match: { token } }` MongoDB read as
 * an operator: the request was answered as the owner of a stored session, with no credential at all.
 *
 * The suite boots the reference `ServerModule` with cookie-parser registered as `src/main.ts` does (a testing module
 * does not run `main.ts`; without it `req.cookies` stays empty and every case below would pass for the wrong reason —
 * hence the recorder that checks the object really reached the request). The operator payloads include one that
 * matches THIS suite's live session, so a value that became a query would certainly have found a session, whatever
 * other suites left in the shared run database.
 *
 * Three layers stop the HTTP case — since 11.44.0 `StringCookiesMiddleware` removes the non-string cookie before any
 * reader sees it (DEV-4144), the token service passes only strings on, the session lookup refuses anything else — so it
 * goes red only with all three removed. Each layer is pinned on its own: `tests/primitive-param-objects.e2e-spec.ts` and
 * its unit spec for the middleware, `tests/unit/better-auth-session-token-type.spec.ts` for the other two, and the
 * lookup case below against the real database. The recorder runs before Nest's middleware and therefore still sees the
 * parsed object.
 */
import { Test } from '@nestjs/testing';
import cookieParser = require('cookie-parser');
import { PubSub } from 'graphql-subscriptions';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter } from '../src';
import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';

describe('DEV-4138: a session cookie that is not a string signs nobody in', () => {
  let app: any;
  let server: any;
  let mongo: MongoClient;
  let betterAuthService: CoreBetterAuthService;
  let sessionCookie: string;
  const seenCookies: any[] = [];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `session-cookie-type-${stamp}@test.com`;
  const password = 'SessionCookieType123!';
  const user = { cookie: '', id: '', sessionToken: '' };

  /** `<name>=j:<json>` as a browser or curl would send it */
  const jsonCookie = (name: string, value: unknown) => `${name}=${encodeURIComponent(`j:${JSON.stringify(value)}`)}`;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    // As src/main.ts registers it
    const cookieSecret = (envConfig as any).jwt?.secret || (envConfig as any).betterAuth?.secret;
    app.use(cookieSecret ? cookieParser(cookieSecret) : cookieParser());
    app.use((req: any, _res: unknown, next: () => void) => {
      if (req.headers['x-record-cookies']) {
        // A copy: StringCookiesMiddleware (11.44.0) deletes the object from this same `req.cookies` afterwards
        seenCookies.push({ ...req.cookies });
      }
      next();
    });
    await app.init();
    server = app.getHttpServer();
    betterAuthService = moduleFixture.get(CoreBetterAuthService);
    sessionCookie = betterAuthService.getSessionCookieName();
    mongo = await MongoClient.connect(envConfig.mongoose.uri);

    const signedUp = await request(server)
      .post('/iam/sign-up/email')
      .send({ email, name: 'Session Cookie Type', password, termsAndPrivacyAccepted: true })
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
    expect(await mongo.db().collection('session').findOne({ token: user.sessionToken })).toBeTruthy();
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

  /** The operator payloads: the one from the report, and one that would match this suite's live session */
  const payloads = (): [string, unknown][] => [
    ['{"$ne":null}', { $ne: null }],
    ['{"$in":[<the live session token>]}', { $in: [user.sessionToken] }],
  ];

  it('paired control: the live session cookie reaches the protected route', async () => {
    const res = await request(server).get(`/users/${user.id}`).set('Cookie', user.cookie).expect(200);

    expect(res.body.id).toBe(user.id);
  });

  it.each([
    ['the session cookie', () => sessionCookie],
    ['the legacy `token` cookie', () => 'token'],
  ])('answers 401 to an operator object in %s, although live sessions exist', async (_label, cookieName) => {
    for (const [payloadLabel, payload] of payloads()) {
      seenCookies.length = 0;

      await request(server)
        .get(`/users/${user.id}`)
        .set('Cookie', jsonCookie(cookieName(), payload))
        .set('x-record-cookies', '1')
        .expect(401);

      // The request really carried the parsed object — otherwise the 401 would prove nothing
      expect(seenCookies[0]?.[cookieName()], payloadLabel).toEqual(payload);
    }
  });

  /**
   * @regression   DEV-4138 — getSessionByToken() put a non-string token into `{ $match: { token } }`, which MongoDB
   *   read as an operator, so `{ $ne: null }` from a `j:` cookie selected somebody else's live session.
   * @seen-failing Drop `!isQueryableString(token) ||` from getSessionByToken() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
   *   `session-lookup-operator-on-real-database` in tests/regression-mutations.json.
   */
  it('finds no session for an operator object on the real database, but the session for its token', async () => {
    for (const [payloadLabel, payload] of payloads()) {
      const result = await betterAuthService.getSessionByToken(payload as never);
      expect(result, payloadLabel).toEqual({ session: null, user: null });
    }

    const own = await betterAuthService.getSessionByToken(user.sessionToken);
    expect(own.session?.token).toBe(user.sessionToken);
    expect(own.user?.email).toBe(email);
  });
});
