/**
 * A session cookie that is not a string signs nobody in (DEV-4138).
 *
 * cookie-parser turns a cookie value starting with `j:` into the parsed JSON, so `iam.session_token=j:{"$ne":null}`
 * reaches `req.cookies` as an object. The middleware ignores it (it reads strings only), and the role guard's fallback
 * passed it through `extractTokenFromRequest()` to `getSessionByToken()`, whose `{ $match: { token } }` MongoDB read as
 * an operator: the request was answered as the owner of a stored session, with no credential at all. On MySQL and
 * MariaDB a number does the same (`j:7`): `WHERE token = 7` compares every token numerically, so `"7Qx…"` matches —
 * the suite runs on those servers too (`IAM_SQL_TEST_INCLUDE`).
 *
 * The suite boots the reference `ServerModule` with cookie-parser registered as `src/main.ts` does (a testing module
 * does not run `main.ts`; without it `req.cookies` stays empty and every case below would pass for the wrong reason —
 * hence the recorder that checks the object really reached the request). The operator payloads include one that
 * matches THIS suite's live session, so a value that became a query would certainly have found a session, whatever
 * other suites left in the shared run database.
 *
 * Two layers stop the HTTP case — the token service passes only strings on, the session lookup refuses anything else —
 * so it goes red only with both removed. Each layer is pinned on its own: the unit spec
 * `tests/unit/better-auth-session-token-type.spec.ts` for both, and the lookup case below against the real database.
 */
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { PubSub } from 'graphql-subscriptions';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { resolveBetterAuthSessionCookieName } from '../src/core/modules/better-auth/better-auth-cookie-prefix.helper';
import { ServerModule } from '../src/server/server.module';
import { type IamTestDb, openIamTestDb } from './helpers/iam-test-db';

describe('DEV-4138: a session cookie that is not a string signs nobody in', () => {
  let app: any;
  let testHelper: TestHelper;
  let iamDb: IamTestDb;
  let betterAuthService: CoreBetterAuthService;
  const sessionCookie = resolveBetterAuthSessionCookieName('iam');
  const seenCookies: any[] = [];
  const user = { email: '', id: '', sessionToken: '' };

  /** `<name>=j:<json>` as a browser or curl would send it */
  const jsonCookie = (name: string, value: unknown) => `${name}=${encodeURIComponent(`j:${JSON.stringify(value)}`)}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
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
    app.use((req: any, _res: unknown, next: () => void) => {
      if (req.headers['x-record-cookies']) {
        seenCookies.push(req.cookies);
      }
      next();
    });
    await app.init();
    testHelper = new TestHelper(app);
    betterAuthService = moduleFixture.get(CoreBetterAuthService);
    iamDb = await openIamTestDb(envConfig.mongoose.uri);

    const email = `session-cookie-type-${Date.now()}-${Math.random().toString(36).substring(7)}@test.com`;
    const password = 'SessionCookieType123!';
    const signedUp: any = await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Session Cookie Type', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    user.email = email;
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

  /** The operator payloads: the one from the report, and one that would match this suite's live session */
  const payloads = (): [string, unknown][] => [
    ['{"$ne":null}', { $ne: null }],
    ['{"$in":[<the live session token>]}', { $in: [user.sessionToken] }],
  ];

  /**
   * The number MySQL / MariaDB turns this suite's session token into when it compares `token = <number>` — the token's
   * leading numeric part, 0 when it starts with anything else. A lookup with it would find exactly this live session.
   */
  const numericTwin = (): number => Number.parseFloat(user.sessionToken) || 0;

  it('paired control: the live session token as a cookie reaches the protected route', async () => {
    const found: any = await testHelper.rest(`/users/${user.id}`, { cookies: user.sessionToken, statusCode: 200 });

    expect(found.id).toBe(user.id);
  });

  it.each([
    ['the session cookie', () => sessionCookie],
    ['the legacy `token` cookie', () => 'token'],
  ])('answers 401 to an operator object in %s, although live sessions exist', async (_label, cookieName) => {
    for (const [payloadLabel, payload] of payloads()) {
      seenCookies.length = 0;

      await testHelper.rest(`/users/${user.id}`, {
        cookies: jsonCookie(cookieName(), payload),
        headers: { 'x-record-cookies': '1' },
        statusCode: 401,
      });

      // The request really carried the parsed object — otherwise the 401 would prove nothing
      expect(seenCookies[0]?.[cookieName()], payloadLabel).toEqual(payload);
    }
  });

  /**
   * @regression   DEV-4138 — getSessionByToken() put a non-string token into `{ $match: { token } }`, which MongoDB
   *   read as an operator, so `{ $ne: null }` from a `j:` cookie selected somebody else's live session; on MySQL /
   *   MariaDB a number matched every token with that numeric prefix.
   * @seen-failing Drop `!isQueryableString(token) ||` from getSessionByToken() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
   *   `session-lookup-operator-on-real-database` in tests/regression-mutations.json.
   */
  it('finds no session for an operator object or a number on the real database, but the session for its token', async () => {
    for (const [payloadLabel, payload] of [...payloads(), ['the token as a number', numericTwin()]] as const) {
      const result = await betterAuthService.getSessionByToken(payload as never);
      expect(result, payloadLabel).toEqual({ session: null, user: null });
    }

    const own = await betterAuthService.getSessionByToken(user.sessionToken);
    expect(own.session?.token).toBe(user.sessionToken);
    expect(own.user?.email).toBe(user.email);
  });
});
