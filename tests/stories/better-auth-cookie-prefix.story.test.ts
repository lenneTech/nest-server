/**
 * Story: COOKIE_PREFIX end-to-end lockstep
 *
 * As an operator deploying multiple lenne.tech apps on the same shared host,
 * I want `COOKIE_PREFIX` to isolate auth cookies across apps,
 * So that sign-in / authenticated requests / sign-out all work with the
 * overridden cookie name and never silently fall back to the default.
 *
 * This is the e2e companion to the cross-layer unit tests in
 * `tests/unit/better-auth-cookie-helper.spec.ts`. The unit tests prove SET
 * and READ agree under override **without** booting Better-Auth; this story
 * boots the real ServerModule (with a real Mongo + a real Better-Auth
 * instance) and walks through the SAME pipeline a browser client would, so
 * any drift between Better-Auth's internal cookie name and the NestJS layer
 * fails the test loudly.
 *
 * The override is set BEFORE the ServerModule import — vitest runs each
 * test file in a forked worker (`pool: 'forks'`), so this env mutation
 * stays isolated to this file.
 */

// MUST come before any other import that may transitively load betterAuth.config:
// `createBetterAuthInstance` captures the prefix at bootstrap and freezes it.
process.env.COOKIE_PREFIX = 'acme';

import { Test, TestingModule } from '@nestjs/testing';
import cookieParser = require('cookie-parser');
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { resolveBetterAuthSessionCookieName } from '../../src/core/modules/better-auth/better-auth-cookie-prefix.helper';
import { ServerModule } from '../../src/server/server.module';

describe('Story: BetterAuth COOKIE_PREFIX end-to-end lockstep', () => {
  let app: any;
  let testHelper: TestHelper;
  let betterAuthService: CoreBetterAuthService;
  let isBetterAuthEnabled: boolean;

  let mongoClient: MongoClient;
  let db: any;

  const testUserIds: string[] = [];
  const testIamUserIds: any[] = [];

  const overriddenCookieName = 'acme.session_token';

  beforeAll(async () => {
    expect(process.env.COOKIE_PREFIX).toBe('acme');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    // src/main.ts registers cookie-parser globally — Test.createTestingModule
    // does NOT, so without this the NestJS read path's `req.cookies?.[name]`
    // lookup would always miss and the e2e would not actually exercise the
    // very layer we are guarding.
    const cookieSecret = (envConfig as any).cookieSecret || (envConfig as any).betterAuth?.secret;
    app.use(cookieSecret ? cookieParser(cookieSecret) : cookieParser());
    await app.init();

    testHelper = new TestHelper(app);
    betterAuthService = moduleFixture.get(CoreBetterAuthService);
    isBetterAuthEnabled = betterAuthService.isEnabled();

    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongoClient.db();
  });

  afterAll(async () => {
    if (db) {
      for (const userId of testUserIds) {
        try {
          await db.collection('users').deleteOne({ _id: new ObjectId(userId) });
        } catch {
          // Cleanup-only, ignore.
        }
      }
      for (const iamId of testIamUserIds) {
        try {
          await db.collection('iam_user').deleteOne({ _id: iamId });
          await db.collection('iam_session').deleteMany({ userId: iamId });
        } catch {
          // Cleanup-only, ignore.
        }
      }
    }
    if (mongoClient) await mongoClient.close();
    if (app) await app.close();
    // The forked worker exits after this file completes, so the env mutation
    // does not leak — but reset anyway for fast-fail debuggability.
    delete process.env.COOKIE_PREFIX;
  });

  function generateTestEmail(): string {
    return `cookie-prefix-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
  }

  it('Resolver agrees with Better-Auth on the overridden prefix', () => {
    // Sanity check: every layer that derives the cookie name from the env
    // now reports the overridden name — not the basePath-derived fallback.
    expect(resolveBetterAuthSessionCookieName('/iam')).toBe(overriddenCookieName);
    if (isBetterAuthEnabled) {
      expect(betterAuthService.getCookiePrefix()).toBe('acme');
      expect(betterAuthService.getSessionCookieName()).toBe(overriddenCookieName);
    }
  });

  it('Sign-up: Better-Auth Set-Cookie uses the overridden prefix (not iam.session_token)', async () => {
    if (!isBetterAuthEnabled) return;

    const email = generateTestEmail();
    const password = 'SecurePassword123!';

    // Use supertest directly because we need raw access to the Set-Cookie
    // header; testHelper.rest() unwraps to the JSON body and drops headers.
    const supertest = require('supertest');
    const signUpRes = await supertest(app.getHttpServer())
      .post('/iam/sign-up/email')
      .send({ email, name: 'Cookie Prefix Test User', password, termsAndPrivacyAccepted: true });

    const iamUser = await db.collection('iam_user').findOne({ email });
    if (iamUser) testIamUserIds.push(iamUser._id);
    const user = await db.collection('users').findOne({ email });
    if (user) testUserIds.push(user._id.toString());

    const setCookieHeaders: string[] = Array.isArray(signUpRes.headers['set-cookie'])
      ? signUpRes.headers['set-cookie']
      : signUpRes.headers['set-cookie']
        ? [signUpRes.headers['set-cookie']]
        : [];

    expect(setCookieHeaders.length).toBeGreaterThan(0);
    const cookieNames = setCookieHeaders.map((h) => h.split('=')[0].trim());

    // The overridden cookie name MUST be set …
    expect(cookieNames).toContain(overriddenCookieName);
    // … and the basePath-default name MUST NOT be set in parallel — the bug
    // would have set both, or only the iam.* one.
    expect(cookieNames).not.toContain('iam.session_token');
    expect(cookieNames).not.toContain('better-auth.session_token');
  });

  it('Authenticated request: session cookie with the overridden name is honoured by the NestJS layer', async () => {
    if (!isBetterAuthEnabled) return;

    const email = generateTestEmail();
    const password = 'SecurePassword123!';

    // Sign up — Better-Auth writes the session row, no need to re-sign-in.
    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'Auth-Cookie Test User', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });

    const iamUser = await db.collection('iam_user').findOne({ email });
    if (iamUser) testIamUserIds.push(iamUser._id);
    const user = await db.collection('users').findOne({ email });
    if (user) testUserIds.push(user._id.toString());

    // Sign-in to materialize a fresh `session` row. The token field in the
    // response body may have been converted to a JWT by the BetterAuth JWT
    // plugin — we want the RAW session token (the DB row's `token` field)
    // because that is what a browser would echo back inside the
    // `acme.session_token` cookie.
    await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email, password },
      statusCode: 200,
    });
    // Better-Auth stores the userId on the session row sometimes as ObjectId,
    // sometimes as string (depends on the IAM user shape) — query both.
    const sessionRow = await db.collection('session').findOne(
      {
        $or: [
          { userId: iamUser?._id },
          { userId: iamUser?._id?.toString() },
          ...(user?._id ? [{ userId: user._id }, { userId: user._id.toString() }] : []),
        ],
      },
      { sort: { createdAt: -1 } },
    );
    expect(sessionRow?.token).toBeTruthy();
    const rawSessionToken: string = sessionRow.token;

    // testHelper.rest with a plain token auto-builds Better-Auth cookies via
    // `buildBetterAuthCookies()` which goes through the SAME resolver as the
    // runtime. Under COOKIE_PREFIX=acme this attaches `acme.session_token=…`.
    // If the NestJS read path were still using `iam.session_token` the
    // request would come back as `{ success: false }`.
    const sessionRes: any = await testHelper.rest('/iam/session', {
      cookies: rawSessionToken,
      method: 'GET',
      statusCode: 200,
    });

    expect(sessionRes?.success).toBe(true);
    expect(sessionRes?.user?.email).toBe(email);
  });

  it('Sign-out: clears the overridden cookie (and only that one)', async () => {
    if (!isBetterAuthEnabled) return;

    // Sign up first so we have a real session cookie to send along — sign-out
    // without a session does nothing, so we would not exercise the clear path.
    const email = generateTestEmail();
    const password = 'SecurePassword123!';
    const supertest = require('supertest');
    const signUpRes = await supertest(app.getHttpServer())
      .post('/iam/sign-up/email')
      .send({ email, name: 'Sign-Out Test User', password, termsAndPrivacyAccepted: true });

    const iamUser = await db.collection('iam_user').findOne({ email });
    if (iamUser) testIamUserIds.push(iamUser._id);
    const user = await db.collection('users').findOne({ email });
    if (user) testUserIds.push(user._id.toString());

    const setCookieFromSignUp: string[] = Array.isArray(signUpRes.headers['set-cookie'])
      ? signUpRes.headers['set-cookie']
      : signUpRes.headers['set-cookie']
        ? [signUpRes.headers['set-cookie']]
        : [];
    const sessionCookieHeader = setCookieFromSignUp.find((h) => h.startsWith(`${overriddenCookieName}=`));
    expect(sessionCookieHeader).toBeDefined();
    const cookiePair = sessionCookieHeader!.split(';')[0];

    // The custom controller exposes POST /iam/sign-out
    const signOutRes = await supertest(app.getHttpServer())
      .post('/iam/sign-out')
      .set('Cookie', cookiePair);

    const setCookieHeaders: string[] = Array.isArray(signOutRes.headers['set-cookie'])
      ? signOutRes.headers['set-cookie']
      : signOutRes.headers['set-cookie']
        ? [signOutRes.headers['set-cookie']]
        : [];

    const cookieNames = setCookieHeaders.map((h) => h.split('=')[0].trim());

    // The NestJS layer's clear-cookie call MUST target the overridden name —
    // otherwise the bug leaves the real session cookie behind in the browser.
    expect(cookieNames).toContain(overriddenCookieName);
    expect(cookieNames).not.toContain('iam.session_token');
  });
});
