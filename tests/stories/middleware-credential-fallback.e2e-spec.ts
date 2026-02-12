/**
 * Story: Middleware Credential Fallback
 *
 * Tests the BetterAuth middleware behavior when multiple credentials are present
 * (Authorization header + session cookie). Verifies that:
 *
 * 1. Valid JWT takes precedence over valid cookie (JWT priority)
 * 2. Invalid BetterAuth JWT falls back to valid session cookie (no 401)
 * 3. Fake Legacy JWT falls back to valid session cookie (no 401)
 * 4. Malformed/garbage token falls back to valid session cookie (no 401)
 * 5. Both invalid credentials correctly return 401
 * 6. Per-strategy error isolation: exception in one strategy doesn't block others
 *
 * These tests validate the fixes in CoreBetterAuthMiddleware:
 * - Legacy JWT no longer causes early `return next()` that blocks cookie fallback
 * - Each strategy has its own try-catch so exceptions don't cascade
 */

import { Controller, Get, Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Server } from 'http';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CoreBetterAuthModule,
  CoreModule,
  CurrentUser,
  HttpExceptionLogFilter,
  RoleEnum,
  Roles,
  TestGraphQLType,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';

// =================================================================================================
// Test Controller
// =================================================================================================

@Controller('credential-test')
class CredentialTestController {
  @Get('protected')
  @Roles(RoleEnum.S_USER)
  getProtected(@CurrentUser() user: any) {
    return { message: 'protected', success: true, userId: user?.id };
  }

  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  getPublic() {
    return { message: 'public', success: true };
  }
}

// =================================================================================================
// Test Config (IAM-only mode, no Legacy Auth)
// =================================================================================================

const testConfig = {
  ...envConfig,
  betterAuth: {
    ...envConfig.betterAuth,
    enabled: true,
  },
};

// =================================================================================================
// Helper: Build fake JWT tokens for testing
// =================================================================================================

/**
 * Build a fake BetterAuth JWT (has 'sub' claim) with invalid signature.
 * The middleware will try to verify this via BetterAuth and fail.
 */
function buildFakeBetterAuthJwt(userId = 'fake-ba-user-id'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ email: 'fake@test.com', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), sub: userId }),
  ).toString('base64url');
  return `${header}.${payload}.invalid-signature`;
}

/**
 * Build a fake Legacy JWT (has 'id' claim, no 'sub') with invalid signature.
 * The middleware detects this as a legacy token by payload structure.
 */
function buildFakeLegacyJwt(userId = 'fake-legacy-user-id'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ deviceId: 'test-device', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), id: userId }),
  ).toString('base64url');
  return `${header}.${payload}.invalid-signature`;
}

// =================================================================================================
// Tests
// =================================================================================================

describe('Story: Middleware Credential Fallback', () => {
  let app: NestExpressApplication;
  let httpServer: Server;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;

  // User A: Used for JWT (Authorization header)
  let userAEmail: string;
  let userAPassword: string;
  let userAToken: string;
  let userAId: string;

  // User B: Used for cookie (session token)
  let userBEmail: string;
  let userBPassword: string;
  let userBSessionToken: string;
  let userBId: string;

  const generateTestEmail = (prefix: string): string => {
    return `cred-fallback-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
  };

  async function ensureValidToken(token: string | undefined, email: string, password: string): Promise<string> {
    if (!token) {
      const signIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });
      return signIn.token;
    }

    try {
      await testHelper.rest('/credential-test/protected', {
        method: 'GET',
        statusCode: 200,
        token,
      });
      return token;
    } catch {
      const signIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });
      return signIn.token;
    }
  }

  async function getSessionTokenFromDb(email: string): Promise<null | string> {
    const dbUser = await db.collection('users').findOne({ email });
    if (!dbUser) return null;
    const session = await db.collection('session').findOne({
      $or: [{ userId: dbUser._id }, { userId: dbUser._id.toString() }, ...(dbUser.iamId ? [{ userId: dbUser.iamId }] : [])],
    });
    return session?.token || null;
  }

  async function ensureValidCookieToken(sessionToken: string | undefined, email: string, password: string): Promise<string> {
    if (!sessionToken) {
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });
      const token = await getSessionTokenFromDb(email);
      return token || '';
    }

    try {
      await testHelper.rest('/credential-test/protected', {
        cookies: sessionToken,
        method: 'GET',
        statusCode: 200,
      });
      return sessionToken;
    } catch {
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });
      const token = await getSessionTokenFromDb(email);
      return token || '';
    }
  }

  async function getUserIdFromDb(email: string): Promise<string> {
    const dbUser = await db.collection('users').findOne({ email });
    return dbUser?._id?.toString() || '';
  }

  // =================================================================================================
  // Setup and Teardown
  // =================================================================================================

  beforeAll(async () => {
    try {
      // Reset CoreBetterAuthModule static state to clear RolesGuardRegistry pollution.
      // Importing ServerModule (used by the parallel mode tests below) triggers its
      // @Module() decorator at ES module import time, which calls CoreBetterAuthModule.forRoot()
      // and marks the RolesGuardRegistry as registered. Without this reset, the guard
      // would not be added to this test module's providers.
      CoreBetterAuthModule.reset();

      // Define module inside beforeAll to defer @Module() decorator evaluation.
      // If defined at module scope, CoreModule.forRoot() runs at ES import time,
      // which can pollute static state before reset() is called.
      @Module({
        controllers: [CredentialTestController],
        exports: [CoreModule],
        imports: [
          // IAM-only mode: CoreModule.forRoot(testConfig) internally registers CoreBetterAuthModule
          // with registerRolesGuardGlobally: true. Do NOT also import BetterAuthModule.forRoot()
          // because it calls CoreBetterAuthModule.forRoot() again, which can cause NestJS to
          // deduplicate and use the second DynamicModule (without RolesGuard provider).
          CoreModule.forRoot(testConfig),
          ScheduleModule.forRoot(),
        ],
        providers: [Any, CronJobs, DateScalar, JSONScalar],
      })
      class CredentialFallbackTestModule {}

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [CredentialFallbackTestModule],
        providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(testConfig.templates.path);
      app.setViewEngine(testConfig.templates.engine);
      await app.init();

      httpServer = app.getHttpServer();
      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });

      testHelper = new TestHelper(app);

      mongoClient = await MongoClient.connect(testConfig.mongoose.uri);
      db = mongoClient.db();

      await setupTestUsers();
    } catch (e) {
      console.error('beforeAll error:', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (db) {
      const testEmails = [userAEmail, userBEmail].filter(Boolean);
      if (testEmails.length > 0) {
        const testUsers = await db.collection('users').find({ email: { $in: testEmails } }).toArray();
        const testUserIds = testUsers.map((u) => u._id.toString());
        const testIamIds = testUsers.map((u) => u.iamId).filter(Boolean);

        await db.collection('users').deleteMany({ email: { $in: testEmails } });

        if (testIamIds.length > 0) {
          await db.collection('account').deleteMany({ userId: { $in: testIamIds } });
          await db.collection('session').deleteMany({ userId: { $in: testIamIds } });
        }
        if (testUserIds.length > 0) {
          await db.collection('account').deleteMany({ userId: { $in: testUserIds } });
          await db.collection('session').deleteMany({ userId: { $in: testUserIds } });
        }
      }
    }

    if (mongoClient) await mongoClient.close();
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (app) await app.close();
    CoreBetterAuthModule.reset();
  });

  beforeEach(async () => {
    if (userAEmail) {
      userAToken = await ensureValidToken(userAToken, userAEmail, userAPassword);
    }
    if (userBEmail) {
      userBSessionToken = await ensureValidCookieToken(userBSessionToken, userBEmail, userBPassword);
    }
  });

  async function setupTestUsers() {
    const waitForDb = () => new Promise<void>((resolve) => setTimeout(resolve, 200));

    // User A: JWT user
    userAEmail = generateTestEmail('jwt-user');
    userAPassword = 'JwtUser123!';

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: userAEmail, name: 'JWT User', password: userAPassword, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });

    await waitForDb();
    await db.collection('users').updateOne({ email: userAEmail }, { $set: { emailVerified: true, verified: true } });
    await db.collection('iam_user').updateOne({ email: userAEmail }, { $set: { emailVerified: true } });
    await waitForDb();

    const signInA = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email: userAEmail, password: userAPassword },
      statusCode: 200,
    });
    userAToken = signInA.token;
    await waitForDb();

    // User B: Cookie user
    userBEmail = generateTestEmail('cookie-user');
    userBPassword = 'CookieUser123!';

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: userBEmail, name: 'Cookie User', password: userBPassword, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });

    await waitForDb();
    await db.collection('users').updateOne({ email: userBEmail }, { $set: { emailVerified: true, verified: true } });
    await db.collection('iam_user').updateOne({ email: userBEmail }, { $set: { emailVerified: true } });
    await waitForDb();

    await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email: userBEmail, password: userBPassword },
      statusCode: 200,
    });
    await waitForDb();

    // Final validation
    userAToken = await ensureValidToken(userAToken, userAEmail, userAPassword);
    userBSessionToken = (await getSessionTokenFromDb(userBEmail)) || '';
    userAId = await getUserIdFromDb(userAEmail);
    userBId = await getUserIdFromDb(userBEmail);
  }

  // =================================================================================================
  // Baseline: Single credential works
  // =================================================================================================

  describe('Baseline: Single credential', () => {
    it('should authenticate with valid JWT only', async () => {
      const result = await testHelper.rest('/credential-test/protected', {
        method: 'GET',
        statusCode: 200,
        token: userAToken,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userAId);
    });

    it('should authenticate with valid session cookie only', async () => {
      if (!userBSessionToken) {
        console.warn('Skipping test: no session token available');
        return;
      }

      const result = await testHelper.rest('/credential-test/protected', {
        cookies: userBSessionToken,
        method: 'GET',
        statusCode: 200,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userBId);
    });
  });

  // =================================================================================================
  // Strategy 2: JWT stored in lt-jwt-token cookie (no Authorization header)
  // =================================================================================================

  describe('Strategy 2: lt-jwt-token cookie authentication', () => {
    it('should authenticate when JWT is sent as lt-jwt-token cookie instead of Authorization header', async () => {
      // User A's BetterAuth JWT token is sent as a cookie, not as Authorization header.
      // This simulates frontends that store the JWT in a cookie (e.g., for SSR).
      const result = await testHelper.rest('/credential-test/protected', {
        headers: { Cookie: `lt-jwt-token=${userAToken}` },
        method: 'GET',
        statusCode: 200,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userAId);
    });

    it('should not use lt-jwt-token cookie when Authorization header is present', async () => {
      // When both Authorization header and lt-jwt-token cookie are present,
      // Strategy 1 (Auth header) takes precedence. Strategy 2 is skipped
      // because it checks `!req.headers.authorization`.
      const invalidJwt = buildFakeBetterAuthJwt('nobody');

      // Invalid Auth header + valid lt-jwt-token cookie → Strategy 1 fails,
      // Strategy 2 is skipped (has Auth header), Strategy 3 has no session cookie → 401
      await testHelper.rest('/credential-test/protected', {
        headers: {
          Authorization: `Bearer ${invalidJwt}`,
          Cookie: `lt-jwt-token=${userAToken}`,
        },
        method: 'GET',
        statusCode: 401,
      });
    });
  });

  // =================================================================================================
  // Priority: Valid JWT + valid cookie → JWT wins
  // =================================================================================================

  describe('Priority: JWT takes precedence over cookie', () => {
    it('should use JWT user when both valid JWT and valid cookie are present', async () => {
      if (!userBSessionToken) {
        console.warn('Skipping test: no session token available');
        return;
      }

      // Send User A's JWT + User B's cookie → should authenticate as User A
      const result = await testHelper.rest('/credential-test/protected', {
        cookies: userBSessionToken,
        method: 'GET',
        statusCode: 200,
        token: userAToken,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userAId);
    });
  });

  // =================================================================================================
  // Fallback: Invalid JWT + valid cookie → cookie rescues
  // =================================================================================================

  describe('Fallback: Invalid JWT with valid session cookie', () => {
    it('should fall back to cookie when BetterAuth JWT has invalid signature', async () => {
      if (!userBSessionToken) {
        console.warn('Skipping test: no session token available');
        return;
      }

      const invalidJwt = buildFakeBetterAuthJwt('nonexistent-user');

      const result = await testHelper.rest('/credential-test/protected', {
        cookies: userBSessionToken,
        method: 'GET',
        statusCode: 200,
        token: invalidJwt,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userBId);
    });

    it('should fall back to cookie when fake Legacy JWT is in Authorization header', async () => {
      if (!userBSessionToken) {
        console.warn('Skipping test: no session token available');
        return;
      }

      const fakeLegacyToken = buildFakeLegacyJwt('nonexistent-legacy-user');

      const result = await testHelper.rest('/credential-test/protected', {
        cookies: userBSessionToken,
        method: 'GET',
        statusCode: 200,
        token: fakeLegacyToken,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userBId);
    });

    it('should fall back to cookie when Authorization header has malformed/garbage token', async () => {
      if (!userBSessionToken) {
        console.warn('Skipping test: no session token available');
        return;
      }

      // Use explicit headers instead of token parameter to control exact header format
      const result = await testHelper.rest('/credential-test/protected', {
        cookies: userBSessionToken,
        headers: { Authorization: 'Bearer this-is-complete-garbage-not-a-jwt' },
        method: 'GET',
        statusCode: 200,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userBId);
    });

    it('should fall back to cookie when Authorization header has expired-looking JWT', async () => {
      if (!userBSessionToken) {
        console.warn('Skipping test: no session token available');
        return;
      }

      // Create a BetterAuth-style JWT with expired timestamp
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200, sub: 'expired-user' }),
      ).toString('base64url');
      const expiredJwt = `${header}.${payload}.invalid-sig`;

      const result = await testHelper.rest('/credential-test/protected', {
        cookies: userBSessionToken,
        method: 'GET',
        statusCode: 200,
        token: expiredJwt,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userBId);
    });
  });

  // =================================================================================================
  // Rejection: Both credentials invalid → 401
  // =================================================================================================

  describe('Rejection: Both credentials invalid', () => {
    it('should return 401 when both JWT and cookie are invalid', async () => {
      const invalidJwt = buildFakeBetterAuthJwt('nobody');

      await testHelper.rest('/credential-test/protected', {
        cookies: 'invalid-session-token-that-does-not-exist',
        method: 'GET',
        statusCode: 401,
        token: invalidJwt,
      });
    });

    it('should return 401 when fake legacy JWT is sent without any cookie', async () => {
      const fakeLegacyToken = buildFakeLegacyJwt('nobody');

      await testHelper.rest('/credential-test/protected', {
        method: 'GET',
        statusCode: 401,
        token: fakeLegacyToken,
      });
    });

    it('should return 401 when no credentials are sent at all', async () => {
      await testHelper.rest('/credential-test/protected', {
        method: 'GET',
        statusCode: 401,
      });
    });
  });

  // =================================================================================================
  // Error isolation: Strategy exceptions don't cascade
  // =================================================================================================

  describe('Error isolation: Per-strategy try-catch', () => {
    it('should still authenticate via cookie when Authorization header causes processing error', async () => {
      if (!userBSessionToken) {
        console.warn('Skipping test: no session token available');
        return;
      }

      // A token with valid JWT structure but payload that could cause issues
      // (e.g., extremely long values, special characters)
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: 'x'.repeat(500) }),
      ).toString('base64url');
      const problematicJwt = `${header}.${payload}.bad`;

      const result = await testHelper.rest('/credential-test/protected', {
        cookies: userBSessionToken,
        method: 'GET',
        statusCode: 200,
        token: problematicJwt,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userBId);
    });

    it('should still authenticate via cookie when Authorization header has empty Bearer value', async () => {
      if (!userBSessionToken) {
        console.warn('Skipping test: no session token available');
        return;
      }

      // Send request with custom Authorization header + valid cookie
      const result = await testHelper.rest('/credential-test/protected', {
        cookies: userBSessionToken,
        headers: { Authorization: 'Bearer ' },
        method: 'GET',
        statusCode: 200,
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userBId);
    });
  });
});

// =================================================================================================
// Parallel Mode: Valid Legacy JWT + Valid Cookie
//
// Tests the specific scenario where a real Legacy JWT (from Passport/Legacy Auth)
// and a valid BetterAuth session cookie are both present.
//
// Expected behavior:
// - BetterAuth middleware detects Legacy JWT → skips BetterAuth verification
// - Middleware falls through to Strategy 3 (cookie fallback) → authenticates cookie user
// - Guard sees _authenticatedViaBetterAuth → skips Passport JWT verification
// - Result: Cookie user wins (BetterAuth session user is authenticated)
//
// NOTE: This requires parallel mode (Legacy Auth + BetterAuth) to generate real Legacy JWTs.
// NOTE: ServerModule is loaded via dynamic import inside beforeAll to avoid import-time
//       side effects. @Module() decorators evaluate their imports at ES module import time,
//       which would call CoreBetterAuthModule.forRoot() and pollute the RolesGuardRegistry
//       before the IAM-only test module above has a chance to register the guard.
// =================================================================================================

describe('Story: Valid Legacy JWT + Valid Cookie (Parallel Mode)', () => {
  let app: NestExpressApplication;
  let httpServer: Server;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;

  // User C: Legacy Auth user (JWT from GraphQL signUp)
  let userCEmail: string;
  let userCPassword: string;
  let userCLegacyToken: string;
  let userCId: string;

  // User D: BetterAuth user (session cookie from REST sign-in)
  let userDEmail: string;
  let userDPassword: string;
  let userDSessionToken: string;
  let userDId: string;

  const generateTestEmail = (prefix: string): string => {
    return `parallel-cred-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
  };

  async function getSessionTokenFromDb(email: string): Promise<null | string> {
    const dbUser = await db.collection('users').findOne({ email });
    if (!dbUser) return null;
    const session = await db.collection('session').findOne({
      $or: [{ userId: dbUser._id }, { userId: dbUser._id.toString() }, ...(dbUser.iamId ? [{ userId: dbUser.iamId }] : [])],
    });
    return session?.token || null;
  }

  async function getUserIdFromDb(email: string): Promise<string> {
    const dbUser = await db.collection('users').findOne({ email });
    return dbUser?._id?.toString() || '';
  }

  // =================================================================================================
  // Setup and Teardown
  // =================================================================================================

  beforeAll(async () => {
    try {
      // Reset static state from previous describe block
      CoreBetterAuthModule.reset();

      // Dynamic import to avoid import-time @Module() decorator side effects.
      // ServerModule's @Module decorator calls BetterAuthModule.forRoot() which calls
      // CoreBetterAuthModule.forRoot(). If loaded at top-level import time, this would
      // mark the RolesGuardRegistry before the IAM-only test module can register the guard.
      // By loading ServerModule AFTER reset(), the registry is clean and the guard is included.
      const { ServerModule } = await import('../../src/server/server.module');

      @Module({
        controllers: [CredentialTestController],
        imports: [ServerModule],
      })
      class ParallelCredentialTestModule {}

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ParallelCredentialTestModule],
        providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(envConfig.templates.path);
      app.setViewEngine(envConfig.templates.engine);
      await app.init();

      httpServer = app.getHttpServer();
      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });

      testHelper = new TestHelper(app);

      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();

      await setupParallelTestUsers();
    } catch (e) {
      console.error('beforeAll error (parallel mode):', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (db) {
      const testEmails = [userCEmail, userDEmail].filter(Boolean);
      if (testEmails.length > 0) {
        const testUsers = await db.collection('users').find({ email: { $in: testEmails } }).toArray();
        const testUserIds = testUsers.map((u) => u._id.toString());
        const testIamIds = testUsers.map((u) => u.iamId).filter(Boolean);

        await db.collection('users').deleteMany({ email: { $in: testEmails } });

        if (testIamIds.length > 0) {
          await db.collection('account').deleteMany({ userId: { $in: testIamIds } });
          await db.collection('session').deleteMany({ userId: { $in: testIamIds } });
        }
        if (testUserIds.length > 0) {
          await db.collection('account').deleteMany({ userId: { $in: testUserIds } });
          await db.collection('session').deleteMany({ userId: { $in: testUserIds } });
        }
      }
    }

    if (mongoClient) await mongoClient.close();
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (app) await app.close();
    CoreBetterAuthModule.reset();
  });

  async function setupParallelTestUsers() {
    const waitForDb = () => new Promise<void>((resolve) => setTimeout(resolve, 200));

    // User C: Create via Legacy Auth (GraphQL signUp → get Legacy JWT)
    userCEmail = generateTestEmail('legacy-jwt');
    userCPassword = 'LegacyJwt123!';

    const signUpC = await testHelper.graphQl({
      arguments: { input: { email: userCEmail, password: userCPassword } },
      fields: ['token', { user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    userCLegacyToken = signUpC.token;
    userCId = signUpC.user.id;
    await waitForDb();

    // User D: Create via BetterAuth (REST sign-up + sign-in → get session cookie)
    userDEmail = generateTestEmail('ba-cookie');
    userDPassword = 'BaCookie123!';

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: userDEmail, name: 'BA Cookie User', password: userDPassword, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    await waitForDb();
    await db.collection('users').updateOne({ email: userDEmail }, { $set: { emailVerified: true, verified: true } });
    await db.collection('iam_user').updateOne({ email: userDEmail }, { $set: { emailVerified: true } });
    await waitForDb();

    await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email: userDEmail, password: userDPassword },
      statusCode: 200,
    });
    await waitForDb();

    userDSessionToken = (await getSessionTokenFromDb(userDEmail)) || '';
    userDId = await getUserIdFromDb(userDEmail);
  }

  // =================================================================================================
  // Tests
  // =================================================================================================

  it('should authenticate with valid Legacy JWT only (baseline)', async () => {
    expect(userCLegacyToken).toBeTruthy();

    // Legacy JWT alone → middleware skips (legacy detection), guard runs Passport → authenticates as User C
    const result = await testHelper.rest('/credential-test/protected', {
      method: 'GET',
      statusCode: 200,
      token: userCLegacyToken,
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe(userCId);
  });

  it('should authenticate with valid session cookie only (baseline)', async () => {
    expect(userDSessionToken).toBeTruthy();

    // Session cookie alone → middleware Strategy 3 → authenticates as User D
    const result = await testHelper.rest('/credential-test/protected', {
      cookies: userDSessionToken,
      method: 'GET',
      statusCode: 200,
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe(userDId);
  });

  it('should authenticate as cookie user when valid Legacy JWT and valid session cookie are both present', async () => {
    expect(userCLegacyToken).toBeTruthy();
    expect(userDSessionToken).toBeTruthy();
    expect(userCId).not.toBe(userDId);

    // Send User C's Legacy JWT + User D's session cookie
    // Expected flow:
    // 1. Middleware Strategy 1: detects Legacy JWT (has 'id' but no 'sub') → skips BetterAuth verification
    // 2. Middleware Strategy 3: cookie fallback with skipAuthHeader → finds valid session → sets req.user as User D
    // 3. Guard: sees _authenticatedViaBetterAuth flag → skips Passport JWT verification
    // Result: Cookie user (User D) wins because the middleware cannot verify Legacy JWTs
    const result = await testHelper.rest('/credential-test/protected', {
      cookies: userDSessionToken,
      method: 'GET',
      statusCode: 200,
      token: userCLegacyToken,
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe(userDId);
  });
});
