/**
 * Story: GraphQL Cookie Authentication via TestHelper
 *
 * As a developer writing tests for GraphQL endpoints,
 * I want to authenticate via cookie-based BetterAuth sessions in `testHelper.graphQl()`,
 * So that my tests reflect production flows where Cookies are the default (v11.25.0+).
 *
 * This test verifies the `cookies` option on `TestGraphQLOptions`
 * (src/test/test.helper.ts). It covers the three usage modes already
 * supported by the REST counterpart:
 *
 * 1. Plain session token string  -> auto-built via `buildBetterAuthCookies()`
 * 2. Record<string, string>      -> joined into a Cookie header
 * 3. Pre-formatted cookie string -> used as-is
 *
 * Plus combined usage with `token` (Authorization header wins, cookie is
 * sent but ignored when a valid JWT is present).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

describe('Story: GraphQL Cookie Authentication (TestHelper.graphQl cookies option)', () => {
  let app: any;
  let testHelper: TestHelper;
  let betterAuthService: CoreBetterAuthService;
  let isBetterAuthEnabled: boolean;

  let mongoClient: MongoClient;
  let db: Db;

  // Test user used for all authenticated GraphQL calls
  let userEmail: string;
  const userPassword = 'CookieAuth123!';
  let userJwtToken: string | undefined;
  let userSessionToken: string | undefined;

  const generateTestEmail = (): string =>
    `gql-cookie-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;

  /**
   * Extract the BetterAuth session token from the `session` collection.
   * Handles both Mongoose ObjectId userIds and string iamId variants.
   */
  async function getSessionTokenFromDb(email: string): Promise<null | string> {
    const dbUser = await db.collection('users').findOne({ email });
    if (!dbUser) return null;
    const session = await db.collection('session').findOne({
      $or: [
        { userId: dbUser._id },
        { userId: dbUser._id.toString() },
        ...(dbUser.iamId ? [{ userId: dbUser.iamId }] : []),
      ],
    });
    return (session?.token as string) || null;
  }

  // =================================================================================================================
  // Setup / Teardown
  // =================================================================================================================

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

    testHelper = new TestHelper(app);
    betterAuthService = moduleFixture.get(CoreBetterAuthService);
    isBetterAuthEnabled = betterAuthService.isEnabled();

    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongoClient.db();

    if (!isBetterAuthEnabled) {
      // All tests are skipped below when BetterAuth is disabled — no setup needed.
      return;
    }

    // Create IAM user with verified email
    userEmail = generateTestEmail();
    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: userEmail, name: 'GQL Cookie User', password: userPassword, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });

    // Ensure user is verified so @Roles(S_VERIFIED)-style guards never reject the test
    await db.collection('users').updateOne({ email: userEmail }, { $set: { emailVerified: true, verified: true } });
    await db.collection('iam_user').updateOne({ email: userEmail }, { $set: { emailVerified: true } });

    // Sign in to create a session record + get a JWT
    const signInRes = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email: userEmail, password: userPassword },
      statusCode: 200,
    });
    userJwtToken = signInRes?.token;

    // Grab the raw session token from the session collection (httpOnly cookie value)
    userSessionToken = (await getSessionTokenFromDb(userEmail)) || undefined;
  });

  afterAll(async () => {
    if (db && userEmail) {
      const dbUser = await db.collection('users').findOne({ email: userEmail });
      if (dbUser) {
        await db.collection('account').deleteMany({ userId: dbUser._id });
        await db.collection('account').deleteMany({ userId: dbUser._id.toString() });
        await db.collection('session').deleteMany({ userId: dbUser._id });
        await db.collection('session').deleteMany({ userId: dbUser._id.toString() });
        if (dbUser.iamId) {
          await db.collection('iam_user').deleteOne({ _id: dbUser.iamId });
          await db.collection('iam_session').deleteMany({ userId: dbUser.iamId });
        }
        await db.collection('users').deleteOne({ _id: dbUser._id });
      }
    }
    if (mongoClient) await mongoClient.close();
    if (app) await app.close();
  });

  // =================================================================================================================
  // Baseline: Auth required for `betterAuthSession`
  // =================================================================================================================

  describe('Baseline', () => {
    it('should reject the authenticated query without any credentials', async () => {
      // `betterAuthSession` uses @Roles(S_USER) — unauthenticated requests are denied by RolesGuard.
      // The response body contains a GraphQL error (or the resolver returns null);
      // either way the query must NOT return a session id.
      const res: any = await testHelper.graphQl({
        fields: ['id', 'expiresAt', { user: ['id', 'email'] }],
        name: 'betterAuthSession',
        type: TestGraphQLType.QUERY,
      });

      const hasError = Array.isArray(res?.errors) && res.errors.length > 0;
      expect(res === null || res === undefined || hasError || !res?.id).toBe(true);
    });
  });

  // =================================================================================================================
  // cookies: plain session token string (auto-detection)
  // =================================================================================================================

  describe('cookies as plain session token (auto-detection)', () => {
    it('should authenticate a GraphQL query when cookies is a raw session token string', async () => {
      if (!isBetterAuthEnabled || !userSessionToken) {
        console.warn('Skipping: BetterAuth disabled or no session token available');
        return;
      }

      const res: any = await testHelper.graphQl(
        {
          fields: ['id', 'expiresAt', { user: ['id', 'email'] }],
          name: 'betterAuthSession',
          type: TestGraphQLType.QUERY,
        },
        { cookies: userSessionToken },
      );

      expect(res).toBeDefined();
      expect(res).not.toBeNull();
      // User object must match the authenticated user
      expect(res.user?.email).toBe(userEmail);
    });
  });

  // =================================================================================================================
  // cookies: Record<string, string>
  // =================================================================================================================

  describe('cookies as Record<string, string>', () => {
    it('should authenticate when cookies is a key/value record containing the session cookie', async () => {
      if (!isBetterAuthEnabled || !userSessionToken) {
        console.warn('Skipping: BetterAuth disabled or no session token available');
        return;
      }

      const res: any = await testHelper.graphQl(
        {
          fields: ['id', { user: ['email'] }],
          name: 'betterAuthSession',
          type: TestGraphQLType.QUERY,
        },
        {
          cookies: {
            'iam.session_token': userSessionToken,
            token: userSessionToken,
          },
        },
      );

      expect(res).toBeDefined();
      expect(res).not.toBeNull();
      expect(res.user?.email).toBe(userEmail);
    });
  });

  // =================================================================================================================
  // cookies: pre-formatted cookie string (contains `=` so auto-detection is skipped)
  // =================================================================================================================

  describe('cookies as pre-formatted cookie string', () => {
    it('should authenticate when cookies is a ready-to-use Cookie-header string', async () => {
      if (!isBetterAuthEnabled || !userSessionToken) {
        console.warn('Skipping: BetterAuth disabled or no session token available');
        return;
      }

      const cookieString = `iam.session_token=${userSessionToken}; token=${userSessionToken}`;

      const res: any = await testHelper.graphQl(
        {
          fields: ['id', { user: ['email'] }],
          name: 'betterAuthSession',
          type: TestGraphQLType.QUERY,
        },
        { cookies: cookieString },
      );

      expect(res).toBeDefined();
      expect(res).not.toBeNull();
      expect(res.user?.email).toBe(userEmail);
    });
  });

  // =================================================================================================================
  // cookies + token simultaneously (JWT priority)
  // =================================================================================================================

  describe('cookies combined with token', () => {
    it('should authenticate when both cookies and a valid JWT token are sent (JWT takes precedence)', async () => {
      if (!isBetterAuthEnabled || !userSessionToken || !userJwtToken) {
        console.warn('Skipping: BetterAuth disabled or missing credentials');
        return;
      }

      // Authorization header JWT wins over session cookie, but both are transmitted —
      // verifies that the `cookies` option does not replace or block the `token` header.
      const res: any = await testHelper.graphQl(
        {
          fields: ['id', { user: ['email'] }],
          name: 'betterAuthSession',
          type: TestGraphQLType.QUERY,
        },
        { cookies: userSessionToken, token: userJwtToken },
      );

      expect(res).toBeDefined();
      expect(res).not.toBeNull();
      expect(res.user?.email).toBe(userEmail);
    });

    it('should fall back to the cookie when the Authorization header contains garbage', async () => {
      if (!isBetterAuthEnabled || !userSessionToken) {
        console.warn('Skipping: BetterAuth disabled or no session token available');
        return;
      }

      // Invalid Auth header + valid session cookie — middleware must fall back to the cookie.
      const res: any = await testHelper.graphQl(
        {
          fields: ['id', { user: ['email'] }],
          name: 'betterAuthSession',
          type: TestGraphQLType.QUERY,
        },
        { cookies: userSessionToken, token: 'this-is-complete-garbage-not-a-jwt' },
      );

      expect(res).toBeDefined();
      expect(res).not.toBeNull();
      expect(res.user?.email).toBe(userEmail);
    });
  });
});
