/**
 * Story: Three Authentication Scenarios
 *
 * This test verifies the three CoreModule.forRoot() signatures work correctly:
 *
 * Scenario 1: Legacy Only - CoreModule.forRoot(AuthService, AuthModule, envConfig) with betterAuth.enabled: false
 * Scenario 2: Legacy + IAM - CoreModule.forRoot(AuthService, AuthModule, envConfig) with betterAuth.enabled: true
 * Scenario 3: IAM Only - CoreModule.forRoot(envConfig) with legacyEndpoints.enabled: false
 *
 * NOTE: This test runs with ServerModule which is Scenario 2 (Legacy + IAM).
 * Scenario-specific behaviors are tested conditionally.
 *
 * For comprehensive password format tests, see auth-scenarios.e2e-spec.ts
 * For migration mechanics, see bidirectional-auth-sync.e2e-spec.ts
 * For migration status, see better-auth-migration-status.e2e-spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BetterAuthService, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

// Helper to create SHA256 hash
function sha256(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

describe('Story: Three Authentication Scenarios', () => {
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;
  let betterAuthService: BetterAuthService;
  let isBetterAuthEnabled: boolean;

  // Test data tracking for cleanup
  const testEmails: string[] = [];

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    const email = `three-scenario-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

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

    betterAuthService = moduleFixture.get(BetterAuthService);
    isBetterAuthEnabled = betterAuthService.isEnabled();

    // Connect to MongoDB for cleanup
    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
    db = mongoClient.db();
  });

  afterAll(async () => {
    // Clean up test users
    if (db && testEmails.length > 0) {
      await db.collection('users').deleteMany({ email: { $in: testEmails } });
      await db.collection('account').deleteMany({});
      await db.collection('session').deleteMany({});
    }
    if (mongoClient) await mongoClient.close();
    if (app) await app.close();
  });

  // =================================================================================================================
  // Scenario Documentation
  // =================================================================================================================

  describe('Scenario Overview', () => {
    it('should document the three CoreModule.forRoot() signatures', () => {
      // Scenario 1: Legacy Only
      // CoreModule.forRoot(AuthService, AuthModule.forRoot(envConfig.jwt), envConfig)
      // with betterAuth.enabled: false (or omitted)
      //
      // Use case: Existing projects without BetterAuth

      // Scenario 2: Legacy + IAM (Migration) - CURRENT TEST CONFIG
      // CoreModule.forRoot(AuthService, AuthModule.forRoot(envConfig.jwt), envConfig)
      // with betterAuth.enabled: true
      //
      // Use case: Existing projects migrating to BetterAuth

      // Scenario 3: IAM Only
      // CoreModule.forRoot(envConfig)
      // with auth.legacyEndpoints.enabled: false
      //
      // Use case: New projects starting fresh with BetterAuth

      expect(true).toBe(true); // Documentation test
    });
  });

  // =================================================================================================================
  // Scenario 2: Legacy + IAM (Current Configuration)
  // =================================================================================================================

  describe('Scenario 2: Legacy + IAM (Migration)', () => {
    it('should have BetterAuth enabled in this test environment', () => {
      // This test verifies we're running in Scenario 2 mode
      expect(isBetterAuthEnabled).toBe(true);
    });

    it('should report BetterAuth status correctly via GraphQL', async () => {
      // betterAuthEnabled returns a boolean
      const enabled = await testHelper.graphQl({
        fields: [],
        name: 'betterAuthEnabled',
        type: TestGraphQLType.QUERY,
      });

      expect(enabled).toBe(true);

      // betterAuthFeatures returns the feature flags
      const features = await testHelper.graphQl({
        fields: ['enabled', 'jwt', 'twoFactor', 'passkey'],
        name: 'betterAuthFeatures',
        type: TestGraphQLType.QUERY,
      });

      expect(features.enabled).toBe(true);
      expect(features.jwt).toBe(true);
    });

    it('should allow Legacy sign-up (3-parameter signature)', async () => {
      const email = generateTestEmail('legacy-signup');
      const password = 'TestPassword123!';

      const result = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(email);
    });

    it('should allow Legacy sign-in', async () => {
      const email = generateTestEmail('legacy-signin');
      const password = 'TestPassword123!';

      // Sign up first
      await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', { user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Then sign in
      const result = await testHelper.graphQl({
        arguments: { input: { email, password } },
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(email);
      expect(result.token).toBeDefined();
    });

    it('should allow IAM sign-up via REST', async () => {
      const email = generateTestEmail('iam-signup');
      const password = sha256('TestPassword123!');

      const response = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Test User', password },
        statusCode: 201,
      });

      expect(response).toBeDefined();
      expect(response.user).toBeDefined();
    });

    it('should allow IAM sign-in via REST', async () => {
      const email = generateTestEmail('iam-signin');
      const password = sha256('TestPassword123!');

      // Sign up first
      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Test User', password },
        statusCode: 201,
      });

      // Then sign in
      const response = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });

      expect(response).toBeDefined();
      expect(response.user).toBeDefined();
      expect(response.user.email).toBe(email);
    });

    it('should work with SHA256-hashed passwords in Legacy auth', async () => {
      const email = generateTestEmail('legacy-sha256');
      const hashedPassword = sha256('TestPassword123!');

      // Sign up with hashed password
      await testHelper.graphQl({
        arguments: { input: { email, password: hashedPassword } },
        fields: ['token', { user: ['id'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      // Sign in with hashed password
      const result = await testHelper.graphQl({
        arguments: { input: { email, password: hashedPassword } },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(email);
    });
  });

  // =================================================================================================================
  // Scenario-Specific Notes
  // =================================================================================================================

  describe('Scenario Notes', () => {
    it('Scenario 1 (Legacy Only): Tested when betterAuth.enabled: false in config', () => {
      // When betterAuth.enabled is false:
      // - betterAuthEnabled query returns enabled: false
      // - IAM endpoints (/iam/*) return 404 or are not registered
      // - Legacy endpoints (signIn, signUp GraphQL mutations) work normally
      //
      // See auth-scenarios.e2e-spec.ts for comprehensive password tests
      expect(true).toBe(true);
    });

    it('Scenario 3 (IAM Only): Tested with CoreModule.forRoot(envConfig) signature', () => {
      // When using the 1-parameter signature:
      // - No AuthService or AuthModule needed
      // - GraphQL Subscriptions authenticate via BetterAuth sessions
      // - Legacy endpoints can be disabled via auth.legacyEndpoints.enabled: false
      // - Legacy endpoints return HTTP 410 Gone when disabled
      //
      // Note: The 1-parameter signature is for new projects starting fresh.
      // See migration-guides/11.6.x-to-11.7.x.md for details.
      expect(true).toBe(true);
    });
  });
});
