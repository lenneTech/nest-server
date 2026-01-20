/**
 * Story: Scenario 1 - Legacy Only Authentication
 *
 * This test verifies the Legacy-Only configuration:
 * - CoreModule.forRoot(AuthService, AuthModule, envConfig) with betterAuth.enabled: false
 * - Only Legacy Auth endpoints are available (GraphQL signIn, signUp, refreshToken)
 * - IAM endpoints (/iam/*) are NOT registered
 * - Password hash: bcrypt(sha256(password))
 *
 * Use case: Existing projects without BetterAuth
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, CoreModule, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { AuthController } from '../../src/server/modules/auth/auth.controller';
import { AuthModule } from '../../src/server/modules/auth/auth.module';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';

// Helper to create SHA256 hash
function sha256(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

// Scenario 1 Config: Legacy Only (BetterAuth disabled)
const scenario1Config = {
  ...envConfig,
  betterAuth: {
    ...envConfig.betterAuth,
    enabled: false, // Explicitly disable BetterAuth
  },
};

/**
 * Test Module for Scenario 1: Legacy Only
 *
 * Uses the 3-parameter CoreModule.forRoot signature with BetterAuth disabled.
 */
@Module({
  controllers: [ServerController, AuthController],
  exports: [CoreModule, AuthModule, FileModule],
  imports: [
    // 3-parameter signature with BetterAuth disabled
    CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(scenario1Config.jwt), scenario1Config),
    ScheduleModule.forRoot(),
    AuthModule.forRoot(scenario1Config.jwt),
    FileModule,
    // Note: NO BetterAuthModule imported!
  ],
  providers: [Any, CronJobs, DateScalar, JSONScalar],
})
class Scenario1ServerModule {}

describe('Story: Scenario 1 - Legacy Only', () => {
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let betterAuthService: CoreBetterAuthService | null = null;

  // Test data tracking for cleanup
  const testEmails: string[] = [];

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    const email = `s1-legacy-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [Scenario1ServerModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(scenario1Config.templates.path);
    app.setViewEngine(scenario1Config.templates.engine);
    await app.init();
    testHelper = new TestHelper(app);

    // Try to get CoreBetterAuthService - should exist but be disabled
    try {
      betterAuthService = moduleFixture.get(CoreBetterAuthService, { strict: false });
    } catch {
      betterAuthService = null;
    }

    // Connect to MongoDB for cleanup
    mongoClient = await MongoClient.connect(scenario1Config.mongoose.uri);
    db = mongoClient.db();
  });

  afterAll(async () => {
    // Clean up test users
    if (db && testEmails.length > 0) {
      await db.collection('users').deleteMany({ email: { $in: testEmails } });
    }
    if (mongoClient) await mongoClient.close();
    if (app) await app.close();
  });

  // =================================================================================================================
  // Scenario 1 Verification
  // =================================================================================================================

  describe('Scenario Configuration', () => {
    it('should have BetterAuth disabled or not available', () => {
      // BetterAuth should either not be available or be disabled
      const isEnabled = betterAuthService?.isEnabled() ?? false;
      expect(isEnabled).toBe(false);
    });

    it('should report BetterAuth as disabled or query not available', async () => {
      // In Legacy Only mode, the betterAuthEnabled query may not be registered
      // Try with status 400 (GraphQL error) first, then check for false result
      try {
        const result = await testHelper.graphQl(
          { fields: [], name: 'betterAuthEnabled', type: TestGraphQLType.QUERY },
          { statusCode: 400 },
        );
        // If we get here with 400, the query doesn't exist
        expect(result.errors).toBeDefined();
      } catch {
        // If status check fails, try with status 200 (query exists but returns false)
        const result = await testHelper.graphQl({
          fields: [],
          name: 'betterAuthEnabled',
          type: TestGraphQLType.QUERY,
        });
        expect(result).toBe(false);
      }
    });
  });

  // =================================================================================================================
  // Legacy Auth Operations
  // =================================================================================================================

  describe('Legacy Auth Operations', () => {
    it('should register user via Legacy GraphQL signUp', async () => {
      const email = generateTestEmail('signup');
      const password = 'LegacyOnlyTest123!';

      const result = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(email);
      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('should sign in user via Legacy GraphQL signIn', async () => {
      const email = generateTestEmail('signin');
      const password = 'LegacySignIn123!';

      // Sign up first
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in
      const result = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(email);
      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('should work with SHA256-hashed passwords', async () => {
      const email = generateTestEmail('sha256');
      const plainPassword = 'SHA256Test123!';
      const hashedPassword = sha256(plainPassword);

      // Sign up with hashed password
      await testHelper.graphQl({
        arguments: { input: { email, password: hashedPassword } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in with hashed password
      const result = await testHelper.graphQl({
        arguments: { input: { email, password: hashedPassword } },
        fields: ['token', { user: ['email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(result.user.email).toBe(email);
    });

    it('should refresh tokens via Legacy refreshToken mutation', async () => {
      const email = generateTestEmail('refresh');
      const password = 'RefreshTest123!';

      // Sign up and get tokens
      const signUpResult = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', 'refreshToken', { user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      expect(signUpResult.refreshToken).toBeDefined();

      // Refresh tokens - pass token in options (second parameter)
      const refreshResult = await testHelper.graphQl(
        {
          arguments: {},
          fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
          name: 'refreshToken',
          type: TestGraphQLType.MUTATION,
        },
        { token: signUpResult.refreshToken },
      );

      expect(refreshResult.token).toBeDefined();
      expect(refreshResult.user.email).toBe(email);
    });

    it('should reject wrong password', async () => {
      const email = generateTestEmail('wrong-pw');
      const correctPassword = 'CorrectPassword123!';
      const wrongPassword = 'WrongPassword123!';

      // Sign up
      await testHelper.graphQl({
        arguments: { input: { email, password: correctPassword } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Attempt sign in with wrong password
      const result = await testHelper.graphQl({
        arguments: { input: { email, password: wrongPassword } },
        fields: ['token'],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Wrong password');
    });
  });

  // =================================================================================================================
  // IAM Endpoints Should Not Be Available
  // =================================================================================================================

  describe('IAM Endpoints Not Available', () => {
    it('should return 404 for IAM sign-up endpoint', async () => {
      const email = generateTestEmail('iam-not-available');
      const password = 'IamNotAvailable123!';

      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Test', password },
        statusCode: 404,
      });
    });

    it('should return 404 for IAM sign-in endpoint', async () => {
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: 'test@test.com', password: 'test' },
        statusCode: 404,
      });
    });

    it('should return 404 for IAM session endpoint', async () => {
      await testHelper.rest('/iam/session', {
        method: 'GET',
        statusCode: 404,
      });
    });
  });

  // =================================================================================================================
  // Password Storage Verification
  // =================================================================================================================

  describe('Password Storage', () => {
    it('should store password as bcrypt hash', async () => {
      const email = generateTestEmail('bcrypt-verify');
      const password = 'BcryptVerify123!';

      // Sign up
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Check database
      const dbUser = await db.collection('users').findOne({ email });
      expect(dbUser).toBeDefined();
      expect(dbUser!.password).toBeDefined();
      expect(dbUser!.password.startsWith('$2')).toBe(true); // bcrypt prefix
      expect(dbUser!.password.length).toBeGreaterThan(50);
    });

    it('should NOT have iamId set (no IAM integration)', async () => {
      const email = generateTestEmail('no-iamid');
      const password = 'NoIamId123!';

      // Sign up
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Check database - iamId should not be set
      const dbUser = await db.collection('users').findOne({ email });
      expect(dbUser).toBeDefined();
      expect(dbUser!.iamId).toBeUndefined();
    });

    it('should NOT have IAM account entry', async () => {
      const email = generateTestEmail('no-account');
      const password = 'NoAccount123!';

      // Sign up
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Check database - no credential account should exist
      const dbUser = await db.collection('users').findOne({ email });
      const iamAccount = await db.collection('account').findOne({
        providerId: 'credential',
        userId: dbUser!._id,
      });
      expect(iamAccount).toBeNull();
    });
  });
});
