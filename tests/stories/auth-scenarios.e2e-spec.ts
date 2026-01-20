/**
 * Story: Authentication Scenarios Tests
 *
 * SCOPE: Tests the three CoreModule.forRoot() usage scenarios with password format variations.
 *
 * As a developer using @lenne.tech/nest-server,
 * I want to verify that all three authentication scenarios work correctly:
 *
 * Scenario 1: Legacy Only (existing projects without BetterAuth)
 * Scenario 2: Legacy + IAM (migration scenario)
 * Scenario 3: IAM Only (new projects)
 *
 * Additionally, tests verify:
 * - Plain text passwords work correctly
 * - SHA256-hashed passwords work correctly
 * - Cross-authentication between both password formats
 *
 * RELATED TESTS (complementary, not duplicates):
 * - bidirectional-auth-sync.e2e-spec.ts: Sync mechanics (email sync, deletion cleanup)
 * - auth-parallel-operation.e2e-spec.ts: Low-level parallel operation (bcrypt, duplicate prevention)
 * - better-auth-enabled.e2e-spec.ts: betterAuthEnabled query
 * - better-auth-migration-status.e2e-spec.ts: Migration status query
 */

import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthService, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

// Helper to create SHA256 hash (simulates client-side hashing)
function sha256(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

describe('Story: Authentication Scenarios', () => {
  // Test environment
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let betterAuthService: CoreBetterAuthService;
  let isBetterAuthEnabled: boolean;

  // Test data tracking for cleanup
  const testEmails: string[] = [];
  const testIamUserIds: string[] = [];

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    const email = `scenario-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ServerModule],
        providers: [
          {
            provide: 'PUB_SUB',
            useValue: new PubSub(),
          },
        ],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalFilters(new HttpExceptionLogFilter());
      app.setBaseViewsDir(envConfig.templates.path);
      app.setViewEngine(envConfig.templates.engine);
      await app.init();
      testHelper = new TestHelper(app);

      // Get Better-Auth service
      betterAuthService = moduleFixture.get(CoreBetterAuthService);
      isBetterAuthEnabled = betterAuthService.isEnabled();

      // Connection to database
      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Clean up test users
    if (db) {
      for (const email of testEmails) {
        await db.collection('users').deleteOne({ email });
        await db.collection('account').deleteMany({});
        await db.collection('session').deleteMany({});
      }
      for (const iamId of testIamUserIds) {
        await db.collection('users').deleteOne({ id: iamId });
        await db.collection('account').deleteMany({ userId: iamId });
        await db.collection('session').deleteMany({ userId: iamId });
      }
    }

    if (mongoClient) {
      await mongoClient.close();
    }

    if (app) {
      await app.close();
    }
  });

  // ===================================================================================================================
  // Scenario 1: Legacy Only
  // ===================================================================================================================

  describe('Scenario 1: Legacy Only', () => {
    it('should register and login via Legacy with plaintext password', async () => {
      const email = generateTestEmail('legacy-plaintext');
      const password = 'LegacyPlainText123!';

      // Sign up via Legacy Auth (GraphQL)
      const signUpRes = await testHelper.graphQl({
        arguments: {
          input: { email, password },
        },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      expect(signUpRes.user).toBeDefined();
      expect(signUpRes.user.email).toBe(email);
      expect(signUpRes.token).toBeDefined();

      // Sign in via Legacy Auth (GraphQL)
      const signInRes = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(signInRes.user).toBeDefined();
      expect(signInRes.user.email).toBe(email);
      expect(signInRes.token).toBeDefined();
      expect(signInRes.refreshToken).toBeDefined();
    });

    it('should register and login via Legacy with SHA256-hashed password', async () => {
      const email = generateTestEmail('legacy-hashed');
      const plainPassword = 'LegacyHashed123!';
      const hashedPassword = sha256(plainPassword);

      // Sign up via Legacy Auth with hashed password
      const signUpRes = await testHelper.graphQl({
        arguments: {
          input: { email, password: hashedPassword },
        },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      expect(signUpRes.user).toBeDefined();
      expect(signUpRes.user.email).toBe(email);

      // Sign in via Legacy Auth with same hashed password
      const signInRes = await testHelper.graphQl({
        arguments: { input: { email, password: hashedPassword } },
        fields: ['token', { user: ['email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(signInRes.user.email).toBe(email);
    });
  });

  // ===================================================================================================================
  // Scenario 2: Legacy + IAM (Migration)
  // ===================================================================================================================

  describe('Scenario 2: Legacy + IAM (Migration)', () => {
    it('should register via Legacy and login via IAM with plaintext password', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('legacy-to-iam-plain');
      const password = 'LegacyToIamPlain123!';

      // Sign up via Legacy
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in via IAM with plaintext password
      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });

      expect(iamSignIn.success).toBe(true);
      expect(iamSignIn.user.email).toBe(email);

      if (iamSignIn.user?.id) {
        testIamUserIds.push(iamSignIn.user.id);
      }
    });

    it('should register via Legacy and login via IAM with SHA256-hashed password', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('legacy-to-iam-hashed');
      const plainPassword = 'LegacyToIamHashed123!';
      const hashedPassword = sha256(plainPassword);

      // Sign up via Legacy with hashed password
      await testHelper.graphQl({
        arguments: { input: { email, password: hashedPassword } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in via IAM with same hashed password
      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: hashedPassword },
      });

      expect(iamSignIn.success).toBe(true);
      expect(iamSignIn.user.email).toBe(email);

      if (iamSignIn.user?.id) {
        testIamUserIds.push(iamSignIn.user.id);
      }
    });

    it('should register via Legacy (plaintext) and login via IAM (hashed)', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('legacy-plain-iam-hashed');
      const plainPassword = 'CrossFormatTest123!';
      const hashedPassword = sha256(plainPassword);

      // Sign up via Legacy with PLAINTEXT password
      await testHelper.graphQl({
        arguments: { input: { email, password: plainPassword } },
        fields: [{ user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in via IAM with HASHED password
      const iamSignIn = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: hashedPassword },
      });

      expect(iamSignIn.success).toBe(true);
      expect(iamSignIn.user.email).toBe(email);

      if (iamSignIn.user?.id) {
        testIamUserIds.push(iamSignIn.user.id);
      }
    });

    it('should register via IAM and login via Legacy with both password formats', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('iam-to-legacy-both');
      const plainPassword = 'IamToLegacyBoth123!';
      const hashedPassword = sha256(plainPassword);

      // Sign up via IAM with hashed password (as clients should)
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM to Legacy User', password: hashedPassword },
        statusCode: 201,
      });

      expect(signUpRes.success).toBe(true);

      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Sign in via Legacy with PLAINTEXT password
      const legacySignInPlain = await testHelper.graphQl({
        arguments: { input: { email, password: plainPassword } },
        fields: ['token', { user: ['email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(legacySignInPlain.user.email).toBe(email);

      // Sign in via Legacy with HASHED password
      const legacySignInHashed = await testHelper.graphQl({
        arguments: { input: { email, password: hashedPassword } },
        fields: ['token', { user: ['email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(legacySignInHashed.user.email).toBe(email);
    });
  });

  // ===================================================================================================================
  // Scenario 3: IAM Only
  // ===================================================================================================================

  describe('Scenario 3: IAM Only', () => {
    it('should register and login via IAM with plaintext password', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('iam-only-plain');
      const password = 'IamOnlyPlain123!';

      // Sign up via IAM with plaintext password
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM Only User', password },
        statusCode: 201,
      });

      expect(signUpRes.success).toBe(true);
      expect(signUpRes.user.email).toBe(email);

      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Sign in via IAM with plaintext password
      const signInRes = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
      });

      expect(signInRes.success).toBe(true);
      expect(signInRes.user.email).toBe(email);
    });

    it('should register and login via IAM with SHA256-hashed password', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('iam-only-hashed');
      const plainPassword = 'IamOnlyHashed123!';
      const hashedPassword = sha256(plainPassword);

      // Sign up via IAM with hashed password (recommended for clients)
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM Hashed User', password: hashedPassword },
        statusCode: 201,
      });

      expect(signUpRes.success).toBe(true);
      expect(signUpRes.user.email).toBe(email);

      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Sign in via IAM with hashed password
      const signInRes = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: hashedPassword },
      });

      expect(signInRes.success).toBe(true);
      expect(signInRes.user.email).toBe(email);
    });

    it('should verify password is normalized to SHA256 before storage', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('iam-normalize');
      const plainPassword = 'NormalizeTest123!';
      const hashedPassword = sha256(plainPassword);

      // Sign up via IAM with PLAINTEXT password
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Normalize Test', password: plainPassword },
        statusCode: 201,
      });

      expect(signUpRes.success).toBe(true);

      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Now sign in with HASHED password - should work because server normalizes
      const signInHashed = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: hashedPassword },
      });

      expect(signInHashed.success).toBe(true);

      // Also sign in with PLAINTEXT - should still work
      const signInPlain = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: plainPassword },
      });

      expect(signInPlain.success).toBe(true);
    });

    it('should sync password to Legacy on IAM sign-up', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('iam-sync-to-legacy');
      const password = 'SyncToLegacy123!';

      // Sign up via IAM
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Sync Test User', password },
        statusCode: 201,
      });

      expect(signUpRes.success).toBe(true);

      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Verify password was synced to users.password (bcrypt hash)
      const dbUser = await db.collection('users').findOne({ email });
      expect(dbUser).toBeDefined();
      expect(dbUser!.password).toBeDefined();
      expect(typeof dbUser!.password).toBe('string');
      expect(dbUser!.password.length).toBeGreaterThan(50); // bcrypt hash is ~60 chars
      expect(dbUser!.password.startsWith('$2')).toBe(true); // bcrypt prefix
    });
  });

  // ===================================================================================================================
  // Password Format Edge Cases
  // ===================================================================================================================

  describe('Password Format Edge Cases', () => {
    it('should reject password that looks like SHA256 but is wrong', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('wrong-hash');
      const correctPassword = 'CorrectPassword123!';
      const wrongHash = 'a'.repeat(64); // 64 hex chars but wrong hash

      // Sign up via IAM with correct password
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Wrong Hash User', password: correctPassword },
        statusCode: 201,
      });

      expect(signUpRes.success).toBe(true);

      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Attempt sign in with wrong hash - should fail
      await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: wrongHash },
        statusCode: 401,
      });
    });

    it('should handle very long passwords correctly', async () => {
      const email = generateTestEmail('long-password');
      const longPassword = `${'A'.repeat(100)}123!`;

      // Sign up via Legacy with long password
      const signUpRes = await testHelper.graphQl({
        arguments: { input: { email, password: longPassword } },
        fields: [{ user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      expect(signUpRes.user).toBeDefined();
      expect(signUpRes.user.email).toBe(email);

      // Sign in via Legacy with same long password
      const signInRes = await testHelper.graphQl({
        arguments: { input: { email, password: longPassword } },
        fields: ['token', { user: ['email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(signInRes.user.email).toBe(email);
    });

    it('should handle passwords with special characters', async () => {
      if (!isBetterAuthEnabled) {
        console.debug('Better-Auth is not enabled, skipping test');
        return;
      }

      const email = generateTestEmail('special-chars');
      const specialPassword = 'P@$$w0rd!#%&*()[]{}|;:<>?,.123';

      // Sign up via IAM
      const signUpRes = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Special Chars User', password: specialPassword },
        statusCode: 201,
      });

      expect(signUpRes.success).toBe(true);

      if (signUpRes.user?.id) {
        testIamUserIds.push(signUpRes.user.id);
      }

      // Sign in via IAM with same password
      const signInRes = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password: specialPassword },
      });

      expect(signInRes.success).toBe(true);

      // Sign in via Legacy (should also work due to password sync)
      const legacySignIn = await testHelper.graphQl({
        arguments: { input: { email, password: specialPassword } },
        fields: ['token', { user: ['email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(legacySignIn.user.email).toBe(email);
    });
  });

  // Note: Migration status query is thoroughly tested in better-auth-migration-status.e2e-spec.ts
  // Note: betterAuthEnabled query is thoroughly tested in better-auth-enabled.e2e-spec.ts
});
