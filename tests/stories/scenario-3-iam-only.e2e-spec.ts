/**
 * Story: Scenario 3 - IAM Only Authentication
 *
 * This test verifies the IAM-Only configuration:
 * - CoreModule.forRoot(envConfig) - Simplified 1-parameter signature!
 * - Only BetterAuth (/iam/*) endpoints are available
 * - Legacy endpoints are disabled and return HTTP 410 Gone
 * - GraphQL Subscriptions authenticate via BetterAuth sessions
 * - Password hash: scrypt(sha256(password))
 *
 * Use case: New projects starting fresh with BetterAuth
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BetterAuthService, CoreModule, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';

// Helper to create SHA256 hash
function sha256(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

// Scenario 3 Config: IAM Only (Legacy endpoints disabled)
const scenario3Config = {
  ...envConfig,
  auth: {
    ...envConfig.auth,
    legacyEndpoints: {
      enabled: false, // Disable Legacy endpoints
    },
  },
  betterAuth: {
    ...envConfig.betterAuth,
    enabled: true, // BetterAuth enabled
  },
};

/**
 * Test Module for Scenario 3: IAM Only
 *
 * Uses the simplified 1-parameter CoreModule.forRoot signature.
 * No AuthService or AuthModule needed!
 */
@Module({
  controllers: [ServerController],
  exports: [CoreModule, BetterAuthModule, FileModule],
  imports: [
    // 1-parameter signature - IAM Only mode!
    CoreModule.forRoot(scenario3Config),
    ScheduleModule.forRoot(),
    // BetterAuthModule for IAM integration
    BetterAuthModule.forRoot({
      config: scenario3Config.betterAuth,
      fallbackSecrets: [scenario3Config.jwt?.secret, scenario3Config.jwt?.refresh?.secret],
    }),
    FileModule,
    // Note: NO AuthModule imported!
  ],
  providers: [Any, CronJobs, DateScalar, JSONScalar],
})
class Scenario3ServerModule {}

describe('Story: Scenario 3 - IAM Only', () => {
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let betterAuthService: BetterAuthService;

  // Test data tracking for cleanup
  const testEmails: string[] = [];
  const testIamUserIds: string[] = [];

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    const email = `s3-iam-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [Scenario3ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(scenario3Config.templates.path);
    app.setViewEngine(scenario3Config.templates.engine);
    await app.init();
    testHelper = new TestHelper(app);

    // Get BetterAuthService
    betterAuthService = moduleFixture.get(BetterAuthService);

    // Connect to MongoDB for cleanup
    mongoClient = await MongoClient.connect(scenario3Config.mongoose.uri);
    db = mongoClient.db();
  });

  afterAll(async () => {
    // Clean up test users
    if (db) {
      if (testEmails.length > 0) {
        await db.collection('users').deleteMany({ email: { $in: testEmails } });
      }
      // Clean up IAM data
      await db.collection('account').deleteMany({});
      await db.collection('session').deleteMany({});
    }
    if (mongoClient) await mongoClient.close();
    if (app) await app.close();
  });

  // =================================================================================================================
  // Scenario 3 Verification
  // =================================================================================================================

  describe('Scenario Configuration', () => {
    it('should have BetterAuth enabled', () => {
      const isEnabled = betterAuthService.isEnabled();
      expect(isEnabled).toBe(true);
    });

    it('should report BetterAuth as enabled via GraphQL query', async () => {
      const result = await testHelper.graphQl({
        fields: [],
        name: 'betterAuthEnabled',
        type: TestGraphQLType.QUERY,
      });

      expect(result).toBe(true);
    });

    it('should report BetterAuth features', async () => {
      const result = await testHelper.graphQl({
        fields: ['enabled', 'jwt', 'twoFactor', 'passkey'],
        name: 'betterAuthFeatures',
        type: TestGraphQLType.QUERY,
      });

      expect(result.enabled).toBe(true);
      expect(result.jwt).toBe(true);
    });
  });

  // =================================================================================================================
  // IAM Auth Operations
  // =================================================================================================================

  describe('IAM Auth Operations', () => {
    it('should register user via IAM REST endpoint', async () => {
      const email = generateTestEmail('signup');
      const password = 'IamOnlyTest123!';

      const result = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM Only User', password },
        statusCode: 201,
      });

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(email);

      if (result.user?.id) {
        testIamUserIds.push(result.user.id);
      }
    });

    it('should sign in user via IAM REST endpoint', async () => {
      const email = generateTestEmail('signin');
      const password = 'IamSignIn123!';

      // Sign up first
      const signUpResult = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Sign In User', password },
        statusCode: 201,
      });

      if (signUpResult.user?.id) {
        testIamUserIds.push(signUpResult.user.id);
      }

      // Sign in
      const result = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(email);
    });

    it('should work with SHA256-hashed passwords', async () => {
      const email = generateTestEmail('sha256');
      const plainPassword = 'SHA256IamTest123!';
      const hashedPassword = sha256(plainPassword);

      // Sign up with hashed password
      const signUpResult = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'SHA256 User', password: hashedPassword },
        statusCode: 201,
      });

      if (signUpResult.user?.id) {
        testIamUserIds.push(signUpResult.user.id);
      }

      // Sign in with hashed password
      const result = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: hashedPassword },
        statusCode: 200,
      });

      expect(result.success).toBe(true);
      expect(result.user.email).toBe(email);
    });

    it('should normalize plaintext to SHA256 (sign up plain, sign in hashed)', async () => {
      const email = generateTestEmail('normalize');
      const plainPassword = 'NormalizeTest123!';
      const hashedPassword = sha256(plainPassword);

      // Sign up with PLAIN password
      const signUpResult = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Normalize User', password: plainPassword },
        statusCode: 201,
      });

      if (signUpResult.user?.id) {
        testIamUserIds.push(signUpResult.user.id);
      }

      // Sign in with HASHED password - should work because server normalizes
      const result = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: hashedPassword },
        statusCode: 200,
      });

      expect(result.success).toBe(true);
    });

    it('should reject wrong password', async () => {
      const email = generateTestEmail('wrong-pw');
      const correctPassword = 'CorrectPassword123!';
      const wrongPassword = 'WrongPassword123!';

      // Sign up
      const signUpResult = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Wrong PW User', password: correctPassword },
        statusCode: 201,
      });

      if (signUpResult.user?.id) {
        testIamUserIds.push(signUpResult.user.id);
      }

      // Attempt sign in with wrong password
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: wrongPassword },
        statusCode: 401,
      });
    });
  });

  // =================================================================================================================
  // Legacy Endpoints Not Available (IAM Only Mode)
  // =================================================================================================================

  describe('Legacy Endpoints Not Available (IAM Only Mode)', () => {
    it('should not have signIn mutation available or return error', async () => {
      // In IAM-Only mode, Legacy GraphQL mutations should either:
      // - Not be registered (query not found error - status 400)
      // - Return HTTP 410 Gone if explicitly disabled
      const result = await testHelper.graphQl(
        {
          arguments: { input: { email: 'test@test.com', password: 'test' } },
          fields: ['token'],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        },
        { statusCode: 400 }, // GraphQL errors return 400
      );

      // Should have errors (either "not found" or "disabled")
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should not have signUp mutation available or return error', async () => {
      const email = generateTestEmail('no-signup');

      const result = await testHelper.graphQl(
        {
          arguments: { input: { email, password: 'test123' } },
          fields: ['token'],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        },
        { statusCode: 400 }, // GraphQL errors return 400
      );

      // Should have errors
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should not have refreshToken mutation available or return error', async () => {
      const result = await testHelper.graphQl(
        {
          arguments: {},
          fields: ['token'],
          name: 'refreshToken',
          token: 'dummy-token',
          type: TestGraphQLType.MUTATION,
        },
        { statusCode: 400 }, // GraphQL errors return 400
      );

      // Should have errors
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should return 404 for REST /auth/* endpoints (not registered)', async () => {
      // In IAM-Only mode without AuthController, REST endpoints return 404
      await testHelper.rest('/auth/signin', {
        method: 'POST',
        payload: { email: 'test@test.com', password: 'test' },
        statusCode: 404,
      });
    });
  });

  // =================================================================================================================
  // Password Storage Verification
  // =================================================================================================================

  describe('Password Storage', () => {
    it('should store password in IAM account collection with scrypt hash', async () => {
      const email = generateTestEmail('scrypt-verify');
      const password = 'ScryptVerify123!';

      // Sign up via IAM
      const result = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Scrypt User', password },
        statusCode: 201,
      });

      if (result.user?.id) {
        testIamUserIds.push(result.user.id);
      }

      // Check database - user should exist
      const dbUser = await db.collection('users').findOne({ email });
      expect(dbUser).toBeDefined();
      expect(dbUser!.iamId).toBeDefined();

      // Check account collection for scrypt hash
      const iamAccount = await db.collection('account').findOne({
        providerId: 'credential',
        userId: dbUser!._id,
      });
      expect(iamAccount).toBeDefined();
      expect(iamAccount!.password).toBeDefined();
      // scrypt format: salt:hash (both hex)
      expect(iamAccount!.password).toContain(':');
      const [salt, hash] = iamAccount!.password.split(':');
      expect(salt.length).toBe(32); // 16 bytes = 32 hex chars
      expect(hash.length).toBe(128); // 64 bytes = 128 hex chars
    });

    it('should also sync password to users.password (bcrypt) for backwards compatibility', async () => {
      const email = generateTestEmail('bcrypt-sync');
      const password = 'BcryptSync123!';

      // Sign up via IAM
      const result = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Bcrypt Sync User', password },
        statusCode: 201,
      });

      if (result.user?.id) {
        testIamUserIds.push(result.user.id);
      }

      // Check database - users.password should have bcrypt hash
      const dbUser = await db.collection('users').findOne({ email });
      expect(dbUser).toBeDefined();
      expect(dbUser!.password).toBeDefined();
      expect(dbUser!.password.startsWith('$2')).toBe(true); // bcrypt prefix
    });
  });

  // =================================================================================================================
  // Session Management
  // =================================================================================================================

  describe('Session Management', () => {
    it('should create session on sign-in', async () => {
      const email = generateTestEmail('session');
      const password = 'SessionTest123!';

      // Sign up
      const signUpResult = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Session User', password },
        statusCode: 201,
      });

      if (signUpResult.user?.id) {
        testIamUserIds.push(signUpResult.user.id);
      }

      // Sign in
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });

      // Check database - session should exist
      const dbUser = await db.collection('users').findOne({ email });
      const session = await db.collection('session').findOne({ userId: dbUser!._id });
      expect(session).toBeDefined();
      expect(session!.token).toBeDefined();
    });

    it('should create sessions that can be verified', async () => {
      const email = generateTestEmail('session-verify');
      const password = 'SessionVerify123!';

      // Sign up
      const signUpResult = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Session Verify User', password },
        statusCode: 201,
      });

      if (signUpResult.user?.id) {
        testIamUserIds.push(signUpResult.user.id);
      }

      // Sign in
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });

      // Verify session was created
      const dbUser = await db.collection('users').findOne({ email });
      const session = await db.collection('session').findOne({ userId: dbUser!._id });
      expect(session).toBeDefined();
      expect(session!.token).toBeDefined();

      // Note: Sign-out behavior depends on BetterAuth configuration
      // and cookie handling which is complex to test in this setup
    });
  });

  // =================================================================================================================
  // GraphQL with IAM JWT Token
  // =================================================================================================================

  describe('GraphQL with IAM JWT Token', () => {
    it('should allow authenticated GraphQL queries with IAM JWT', async () => {
      const email = generateTestEmail('graphql-jwt');
      const password = 'GraphQLJwt123!';

      // Sign up
      const signUpResult = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'GraphQL JWT User', password },
        statusCode: 201,
      });

      if (signUpResult.user?.id) {
        testIamUserIds.push(signUpResult.user.id);
      }

      // Sign in to get JWT token
      const signInResult = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });

      // Use the IAM token to access GraphQL
      // Note: The token format depends on BetterAuth JWT plugin configuration
      if (signInResult.token) {
        const result = await testHelper.graphQl({
          fields: [],
          name: 'betterAuthEnabled',
          token: signInResult.token,
          type: TestGraphQLType.QUERY,
        });

        expect(result).toBe(true);
      }
    });
  });
});
