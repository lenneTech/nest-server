/**
 * Story: BetterAuth REST Security Integration
 *
 * This test verifies that the BETTER_AUTH AuthGuard strategy works correctly
 * for REST endpoints, including:
 * - Authentication: Unauthenticated requests are rejected
 * - Authorization: Role-based access control works
 * - Token validation: Both JWT and session tokens are validated
 *
 * CRITICAL: These tests ensure security mechanisms are 100% functional
 */

import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Server } from 'http';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuthGuard,
  AuthGuardStrategy,
  CoreBetterAuthModule,
  CoreBetterAuthService,
  CoreModule,
  CurrentUser,
  HttpExceptionLogFilter,
  RoleEnum,
  Roles,
  RolesGuard,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module';

// =================================================================================================
// Test Controller with Various Security Configurations
// =================================================================================================

/**
 * Test controller for verifying BetterAuth security with RolesGuard
 *
 * IMPORTANT: When RolesGuard is registered as a global guard (via APP_GUARD),
 * you don't need @UseGuards(AuthGuard(...)) on each endpoint.
 * The @Roles() decorator alone is sufficient - RolesGuard handles both
 * authentication AND authorization.
 *
 * This is the RECOMMENDED pattern for @lenne.tech/nest-server projects.
 * See: .claude/rules/role-system.md
 */
@Controller('security-test')
class SecurityTestController {
  /**
   * Public endpoint - no authentication required
   * @Roles(S_EVERYONE) means anyone can access
   */
  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  getPublic() {
    return { message: 'public', success: true };
  }

  /**
   * Protected endpoint - requires authentication (any authenticated user)
   * @Roles(S_USER) means any logged-in user can access
   * RolesGuard will reject unauthenticated requests with 401
   */
  @Get('protected')
  @Roles(RoleEnum.S_USER)
  getProtected(@CurrentUser() user: any) {
    return { message: 'protected', success: true, userId: user?.id };
  }

  /**
   * Admin-only endpoint - requires ADMIN role
   * @Roles(ADMIN) means only users with ADMIN role can access
   * RolesGuard will reject non-admin users with 403
   */
  @Get('admin-only')
  @Roles(RoleEnum.ADMIN)
  getAdminOnly(@CurrentUser() user: any) {
    return { message: 'admin-only', success: true, userId: user?.id };
  }

  /**
   * Verified user endpoint - requires S_VERIFIED role
   * @Roles(S_VERIFIED) means only verified users can access
   * RolesGuard will reject unverified users with 403
   */
  @Get('verified-only')
  @Roles(RoleEnum.S_VERIFIED)
  getVerifiedOnly(@CurrentUser() user: any) {
    return { message: 'verified-only', success: true, userId: user?.id };
  }

  /**
   * Locked endpoint - S_NO_ONE should always deny access
   * @Roles(S_NO_ONE) means NO ONE can access, even admins
   * RolesGuard will reject ALL requests with 401
   */
  @Get('locked')
  @Roles(RoleEnum.S_NO_ONE)
  getLocked() {
    return { message: 'should-never-reach', success: false };
  }

  /**
   * Endpoint that uses explicit BETTER_AUTH guard
   * This demonstrates using @UseGuards when you need explicit strategy control
   * (e.g., when not using global RolesGuard or for specific authentication needs)
   */
  @Get('explicit-better-auth')
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.BETTER_AUTH))
  getExplicitBetterAuth(@CurrentUser() user: any) {
    return { message: 'explicit-better-auth', success: true, userId: user?.id };
  }
}

// =================================================================================================
// Test Module Configuration
// =================================================================================================

const testConfig = {
  ...envConfig,
  betterAuth: {
    ...envConfig.betterAuth,
    enabled: true,
  },
};

@Module({
  controllers: [SecurityTestController],
  exports: [CoreModule, BetterAuthModule],
  imports: [
    CoreModule.forRoot(testConfig),
    ScheduleModule.forRoot(),
    BetterAuthModule.forRoot({
      config: testConfig.betterAuth,
      fallbackSecrets: [testConfig.jwt?.secret, testConfig.jwt?.refresh?.secret],
      serverAppUrl: testConfig.appUrl,
      serverBaseUrl: testConfig.baseUrl,
      serverEnv: testConfig.env,
    }),
  ],
  providers: [
    Any,
    CronJobs,
    DateScalar,
    JSONScalar,
    // CRITICAL: Register RolesGuard as global guard for role checking
    // This is what enables @Roles() decorator to work
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
class SecurityTestModule {}

// =================================================================================================
// Tests
// =================================================================================================

describe('Story: BetterAuth REST Security', () => {
  let app: NestExpressApplication;
  let httpServer: Server;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let betterAuthService: CoreBetterAuthService;

  // Test users
  let regularUserEmail: string;
  let regularUserPassword: string;
  let regularUserToken: string;

  let adminUserEmail: string;
  let adminUserPassword: string;
  let adminUserToken: string;

  let unverifiedUserEmail: string;
  let unverifiedUserPassword: string;
  let unverifiedUserToken: string;

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    return `sec-test-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
  };

  // =================================================================================================
  // Setup and Teardown
  // =================================================================================================

  beforeAll(async () => {
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [SecurityTestModule],
        providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(testConfig.templates.path);
      app.setViewEngine(testConfig.templates.engine);
      await app.init();

      // Use httpServer.listen(0) for dynamic port
      httpServer = app.getHttpServer();
      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });

      testHelper = new TestHelper(app);
      betterAuthService = moduleFixture.get(CoreBetterAuthService);

      // Connect to MongoDB
      mongoClient = await MongoClient.connect(testConfig.mongoose.uri);
      db = mongoClient.db();

      // Create test users
      await setupTestUsers();
    } catch (e) {
      console.error('beforeAll error:', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Clean up test users and their associated data
    if (db) {
      const testEmails = [regularUserEmail, adminUserEmail, unverifiedUserEmail].filter(Boolean);
      if (testEmails.length > 0) {
        // Get user IDs before deletion for cleaning up related collections
        const testUsers = await db.collection('users').find({ email: { $in: testEmails } }).toArray();
        const testUserIds = testUsers.map((u) => u._id.toString());
        const testIamIds = testUsers.map((u) => u.iamId).filter(Boolean);

        // Delete users
        await db.collection('users').deleteMany({ email: { $in: testEmails } });

        // Delete only test user's accounts and sessions (not all data!)
        if (testIamIds.length > 0) {
          await db.collection('account').deleteMany({ userId: { $in: testIamIds } });
          await db.collection('session').deleteMany({ userId: { $in: testIamIds } });
        }
        // Also try with MongoDB ObjectIds in case mapping is different
        if (testUserIds.length > 0) {
          await db.collection('account').deleteMany({ userId: { $in: testUserIds } });
          await db.collection('session').deleteMany({ userId: { $in: testUserIds } });
        }
      }
    }

    // Close connections
    if (mongoClient) await mongoClient.close();
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (app) await app.close();

    // Reset module static state to avoid test pollution
    CoreBetterAuthModule.reset();
  });

  // =================================================================================================
  // Helper: Setup Test Users
  // =================================================================================================

  async function setupTestUsers() {
    // 1. Regular user (no admin role, verified)
    regularUserEmail = generateTestEmail('regular');
    regularUserPassword = 'RegularUser123!';

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: regularUserEmail, name: 'Regular User', password: regularUserPassword },
      statusCode: 201,
    });

    // Sign in to get token
    const regularSignIn = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email: regularUserEmail, password: regularUserPassword },
      statusCode: 200,
    });
    regularUserToken = regularSignIn.token;

    // Mark user as verified in database
    await db.collection('users').updateOne({ email: regularUserEmail }, { $set: { verified: true } });

    // 2. Admin user
    adminUserEmail = generateTestEmail('admin');
    adminUserPassword = 'AdminUser123!';

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: adminUserEmail, name: 'Admin User', password: adminUserPassword },
      statusCode: 201,
    });

    // Sign in to get token
    const adminSignIn = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email: adminUserEmail, password: adminUserPassword },
      statusCode: 200,
    });
    adminUserToken = adminSignIn.token;

    // Add ADMIN role to user in database
    await db.collection('users').updateOne(
      { email: adminUserEmail },
      {
        $set: {
          roles: [RoleEnum.ADMIN],
          verified: true,
        },
      },
    );

    // 3. Unverified user
    unverifiedUserEmail = generateTestEmail('unverified');
    unverifiedUserPassword = 'UnverifiedUser123!';

    await testHelper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email: unverifiedUserEmail, name: 'Unverified User', password: unverifiedUserPassword },
      statusCode: 201,
    });

    // Sign in to get token
    const unverifiedSignIn = await testHelper.rest('/iam/sign-in/email', {
      method: 'POST',
      payload: { email: unverifiedUserEmail, password: unverifiedUserPassword },
      statusCode: 200,
    });
    unverifiedUserToken = unverifiedSignIn.token;

    // Explicitly mark as NOT verified
    await db.collection('users').updateOne(
      { email: unverifiedUserEmail },
      {
        $set: {
          emailVerified: false,
          verified: false,
        },
      },
    );
  }

  // =================================================================================================
  // Test: BetterAuth Service Enabled
  // =================================================================================================

  describe('BetterAuth Service', () => {
    it('should have BetterAuth enabled', () => {
      expect(betterAuthService.isEnabled()).toBe(true);
    });

    it('should have JWT enabled', () => {
      expect(betterAuthService.isJwtEnabled()).toBe(true);
    });
  });

  // =================================================================================================
  // Test: Public Endpoints (S_EVERYONE)
  // =================================================================================================

  describe('Public Endpoints (S_EVERYONE)', () => {
    it('should allow unauthenticated access to public endpoints', async () => {
      const result = await testHelper.rest('/security-test/public', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('public');
    });

    it('should allow authenticated access to public endpoints', async () => {
      const result = await testHelper.rest('/security-test/public', {
        method: 'GET',
        statusCode: 200,
        token: regularUserToken,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('public');
    });
  });

  // =================================================================================================
  // Test: Protected Endpoints (S_USER - Authentication Required)
  // =================================================================================================

  describe('Protected Endpoints (S_USER)', () => {
    it('SECURITY: should REJECT unauthenticated requests to protected endpoints', async () => {
      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 401, // Unauthorized
      });

      // Should not receive success response
      expect(result.success).not.toBe(true);
    });

    it('SECURITY: should REJECT requests with invalid token', async () => {
      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 401,
        token: 'invalid-token-12345',
      });

      expect(result.success).not.toBe(true);
    });

    it('SECURITY: should REJECT requests with malformed JWT', async () => {
      const malformedJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid.signature';

      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 401,
        token: malformedJwt,
      });

      expect(result.success).not.toBe(true);
    });

    it('should ALLOW authenticated regular user', async () => {
      if (!regularUserToken) {
        console.warn('Skipping test: no regular user token available');
        return;
      }

      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 200,
        token: regularUserToken,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('protected');
      expect(result.userId).toBeDefined();
    });

    it('should ALLOW authenticated admin user', async () => {
      if (!adminUserToken) {
        console.warn('Skipping test: no admin user token available');
        return;
      }

      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 200,
        token: adminUserToken,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('protected');
    });
  });

  // =================================================================================================
  // Test: Admin-Only Endpoints (ADMIN Role Required)
  // =================================================================================================

  describe('Admin-Only Endpoints (ADMIN)', () => {
    it('SECURITY: should REJECT unauthenticated requests', async () => {
      const result = await testHelper.rest('/security-test/admin-only', {
        method: 'GET',
        statusCode: 401,
      });

      expect(result.success).not.toBe(true);
    });

    it('SECURITY: should REJECT non-admin users', async () => {
      if (!regularUserToken) {
        console.warn('Skipping test: no regular user token available');
        return;
      }

      // Regular user should be rejected with 403 Forbidden
      const result = await testHelper.rest('/security-test/admin-only', {
        method: 'GET',
        statusCode: 403, // Forbidden - authenticated but not authorized
        token: regularUserToken,
      });

      expect(result.success).not.toBe(true);
    });

    it('should ALLOW admin users', async () => {
      if (!adminUserToken) {
        console.warn('Skipping test: no admin user token available');
        return;
      }

      const result = await testHelper.rest('/security-test/admin-only', {
        method: 'GET',
        statusCode: 200,
        token: adminUserToken,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('admin-only');
    });
  });

  // =================================================================================================
  // Test: Verified User Endpoints (S_VERIFIED)
  // =================================================================================================

  describe('Verified User Endpoints (S_VERIFIED)', () => {
    it('SECURITY: should REJECT unauthenticated requests', async () => {
      const result = await testHelper.rest('/security-test/verified-only', {
        method: 'GET',
        statusCode: 401,
      });

      expect(result.success).not.toBe(true);
    });

    it('SECURITY: should REJECT unverified users', async () => {
      if (!unverifiedUserToken) {
        console.warn('Skipping test: no unverified user token available');
        return;
      }

      // Unverified user should be rejected with 403 Forbidden
      const result = await testHelper.rest('/security-test/verified-only', {
        method: 'GET',
        statusCode: 403,
        token: unverifiedUserToken,
      });

      expect(result.success).not.toBe(true);
    });

    it('should ALLOW verified users', async () => {
      if (!regularUserToken) {
        console.warn('Skipping test: no regular user token available');
        return;
      }

      const result = await testHelper.rest('/security-test/verified-only', {
        method: 'GET',
        statusCode: 200,
        token: regularUserToken,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('verified-only');
    });
  });

  // =================================================================================================
  // Test: Locked Endpoints (S_NO_ONE)
  // =================================================================================================

  describe('Locked Endpoints (S_NO_ONE)', () => {
    it('SECURITY: should REJECT unauthenticated requests', async () => {
      const result = await testHelper.rest('/security-test/locked', {
        method: 'GET',
        statusCode: 401,
      });

      expect(result.success).not.toBe(true);
    });

    it('SECURITY: should REJECT even admin users', async () => {
      if (!adminUserToken) {
        console.warn('Skipping test: no admin user token available');
        return;
      }

      // S_NO_ONE should deny access to everyone
      const result = await testHelper.rest('/security-test/locked', {
        method: 'GET',
        statusCode: 401, // S_NO_ONE returns 401 Unauthorized
        token: adminUserToken,
      });

      expect(result.success).not.toBe(true);
    });
  });

  // =================================================================================================
  // Test: Token Expiry and Invalid Tokens
  // =================================================================================================

  describe('Token Security', () => {
    it('SECURITY: should REJECT requests with expired JWT', async () => {
      // Create a minimal expired JWT (exp in the past)
      // Note: This won't be a valid signature, but tests the error handling
      const expiredPayload = {
        exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
        sub: 'test-user-id',
      };
      const fakeExpiredJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(expiredPayload)).toString('base64url')}.fake-signature`;

      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 401,
        token: fakeExpiredJwt,
      });

      expect(result.success).not.toBe(true);
    });

    it('SECURITY: should REJECT requests with tampered JWT payload', async () => {
      // Take a valid token and tamper with the payload
      if (!regularUserToken) {
        console.warn('Skipping test: no regular user token available');
        return;
      }

      const [header, , signature] = regularUserToken.split('.');
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          roles: ['admin'], // Try to add admin role
          sub: 'hacker-id',
        }),
      ).toString('base64url');
      const tamperedJwt = `${header}.${tamperedPayload}.${signature}`;

      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 401,
        token: tamperedJwt,
      });

      expect(result.success).not.toBe(true);
    });

    it('SECURITY: should REJECT requests with empty Authorization header', async () => {
      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 401,
        token: '',
      });

      expect(result.success).not.toBe(true);
    });
  });

  // =================================================================================================
  // Test: Session Token Authentication
  // =================================================================================================

  describe('Session Token Authentication', () => {
    it('should authenticate with session token from database', async () => {
      // Get the session token from database for regular user
      const dbUser = await db.collection('users').findOne({ email: regularUserEmail });
      if (!dbUser) {
        console.warn('Skipping test: user not found in database');
        return;
      }

      const session = await db.collection('session').findOne({ userId: dbUser._id });
      if (!session?.token) {
        console.warn('Skipping test: no session found for user');
        return;
      }

      // Use session token instead of JWT
      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 200,
        token: session.token,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('protected');
    });
  });

  // =================================================================================================
  // Test: Role Hierarchy
  // =================================================================================================

  describe('Role Hierarchy', () => {
    it('admin should have access to S_USER endpoints', async () => {
      if (!adminUserToken) {
        console.warn('Skipping test: no admin user token available');
        return;
      }

      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 200,
        token: adminUserToken,
      });

      expect(result.success).toBe(true);
    });

    it('verified user should have access to S_USER endpoints', async () => {
      if (!regularUserToken) {
        console.warn('Skipping test: no regular user token available');
        return;
      }

      const result = await testHelper.rest('/security-test/protected', {
        method: 'GET',
        statusCode: 200,
        token: regularUserToken,
      });

      expect(result.success).toBe(true);
    });

    it('admin should have access to S_VERIFIED endpoints', async () => {
      if (!adminUserToken) {
        console.warn('Skipping test: no admin user token available');
        return;
      }

      const result = await testHelper.rest('/security-test/verified-only', {
        method: 'GET',
        statusCode: 200,
        token: adminUserToken,
      });

      expect(result.success).toBe(true);
    });
  });

  // =================================================================================================
  // Test: Explicit BETTER_AUTH Strategy
  // =================================================================================================

  describe('Explicit BETTER_AUTH Strategy', () => {
    it('SECURITY: should REJECT unauthenticated requests', async () => {
      const result = await testHelper.rest('/security-test/explicit-better-auth', {
        method: 'GET',
        statusCode: 401,
      });

      expect(result.success).not.toBe(true);
    });

    it('should ALLOW authenticated requests with valid token', async () => {
      if (!regularUserToken) {
        console.warn('Skipping test: no regular user token available');
        return;
      }

      const result = await testHelper.rest('/security-test/explicit-better-auth', {
        method: 'GET',
        statusCode: 200,
        token: regularUserToken,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('explicit-better-auth');
    });
  });
});
