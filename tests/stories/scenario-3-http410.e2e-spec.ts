/**
 * Story: Scenario 3 - HTTP 410 Gone for Disabled Legacy Endpoints
 *
 * This test verifies the correct HTTP 410 Gone response when:
 * - AuthResolver IS registered (Legacy Auth code is in the project)
 * - BUT auth.legacyEndpoints.enabled is set to false
 *
 * This is the realistic scenario for existing projects that have:
 * 1. Migrated all users to BetterAuth (IAM)
 * 2. Want to disable Legacy Auth endpoints without removing code
 *
 * The LegacyAuthDisabledException returns HTTP 410 Gone to indicate
 * that the resource is permanently unavailable.
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreModule, HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { AuthController } from '../../src/server/modules/auth/auth.controller';
import { AuthModule } from '../../src/server/modules/auth/auth.module';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';

// Config: AuthResolver registered, but Legacy endpoints DISABLED
const http410Config = {
  ...envConfig,
  auth: {
    ...envConfig.auth,
    legacyEndpoints: {
      enabled: false, // DISABLED - should return HTTP 410
    },
  },
  betterAuth: {
    ...envConfig.betterAuth,
    enabled: true,
  },
};

/**
 * Test Module: Legacy Auth registered but disabled via config
 *
 * This simulates a project that:
 * - Still has AuthModule code
 * - Has migrated to BetterAuth
 * - Wants to disable Legacy endpoints without removing code
 */
@Module({
  controllers: [ServerController, AuthController],
  exports: [CoreModule, AuthModule, BetterAuthModule, FileModule],
  imports: [
    // 3-param signature WITH AuthModule (Legacy code still present)
    CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(http410Config.jwt), http410Config),
    ScheduleModule.forRoot(),
    AuthModule.forRoot(http410Config.jwt),
    BetterAuthModule.forRoot({
      config: http410Config.betterAuth,
      fallbackSecrets: [http410Config.jwt?.secret, http410Config.jwt?.refresh?.secret],
    }),
    FileModule,
  ],
  providers: [Any, CronJobs, DateScalar, JSONScalar],
})
class Http410TestModule {}

describe('Story: Scenario 3 - HTTP 410 for Disabled Legacy Endpoints', () => {
  let app;
  let testHelper: TestHelper;
  let mongoClient: MongoClient;
  let db: Db;

  // Test data tracking for cleanup
  const testEmails: string[] = [];

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    const email = `http410-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [Http410TestModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(http410Config.templates.path);
    app.setViewEngine(http410Config.templates.engine);
    await app.init();
    testHelper = new TestHelper(app);

    // Connect to MongoDB for cleanup
    mongoClient = await MongoClient.connect(http410Config.mongoose.uri);
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
  // GraphQL Legacy Endpoints Return Error with "disabled" message
  // =================================================================================================================

  describe('GraphQL Legacy Endpoints Return LegacyAuthDisabledException', () => {
    it('should return error with "disabled" message for signIn mutation', async () => {
      const result = await testHelper.graphQl(
        {
          arguments: { input: { email: 'test@test.com', password: 'test' } },
          fields: ['token'],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        },
        { statusCode: 200 }, // GraphQL returns 200 even with errors in body
      );

      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);

      const errorMessage = result.errors[0].message.toLowerCase();
      expect(errorMessage).toContain('disabled');
      expect(errorMessage).toContain('legacy');
    });

    it('should return error with "disabled" message for signUp mutation', async () => {
      const email = generateTestEmail('signup');

      const result = await testHelper.graphQl(
        {
          arguments: { input: { email, password: 'Test123!' } },
          fields: ['token'],
          name: 'signUp',
          type: TestGraphQLType.MUTATION,
        },
        { statusCode: 200 },
      );

      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);

      const errorMessage = result.errors[0].message.toLowerCase();
      expect(errorMessage).toContain('disabled');
    });

    it('should return error with "BetterAuth" alternative mentioned', async () => {
      const result = await testHelper.graphQl(
        {
          arguments: { input: { email: 'test@test.com', password: 'test' } },
          fields: ['token'],
          name: 'signIn',
          type: TestGraphQLType.MUTATION,
        },
        { statusCode: 200 },
      );

      expect(result.errors).toBeDefined();

      // Error should mention BetterAuth as alternative
      const errorMessage = result.errors[0].message;
      expect(errorMessage).toContain('BetterAuth');
    });
  });

  // =================================================================================================================
  // REST Legacy Endpoints Return HTTP 410 Gone
  // =================================================================================================================

  describe('REST Legacy Endpoints Return HTTP 410 Gone', () => {
    it('should return HTTP 410 for POST /auth/signin', async () => {
      const response: any = await testHelper.rest('/auth/signin', {
        method: 'POST',
        payload: { email: 'test@test.com', password: 'test' },
        statusCode: 410,
      });

      // REST error responses have status (not statusCode at top level)
      expect(response.status).toBe(410);
      expect(response.response?.statusCode).toBe(410);
      expect(response.message).toContain('disabled');
    });

    it('should return HTTP 410 for POST /auth/signup', async () => {
      const email = generateTestEmail('rest-signup');

      const response: any = await testHelper.rest('/auth/signup', {
        method: 'POST',
        payload: { email, password: 'Test123!' },
        statusCode: 410,
      });

      expect(response.status).toBe(410);
      expect(response.response?.statusCode).toBe(410);
    });
  });

  // =================================================================================================================
  // BetterAuth (IAM) Endpoints Still Work
  // =================================================================================================================

  describe('BetterAuth (IAM) Endpoints Still Work', () => {
    it('should allow sign-up via IAM endpoint', async () => {
      const email = generateTestEmail('iam-works');
      const password = 'IamStillWorks123!';

      const result = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM User', password },
        statusCode: 201,
      });

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(email);
    });

    it('should allow sign-in via IAM endpoint', async () => {
      const email = generateTestEmail('iam-signin');
      const password = 'IamSignIn123!';

      // Sign up first
      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'IAM Sign In User', password },
        statusCode: 201,
      });

      // Sign in
      const result = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
    });

    it('should report betterAuthEnabled as true', async () => {
      const result = await testHelper.graphQl({
        fields: [],
        name: 'betterAuthEnabled',
        type: TestGraphQLType.QUERY,
      });

      expect(result).toBe(true);
    });
  });

  // =================================================================================================================
  // Documentation: This is the Recommended Migration End-State
  // =================================================================================================================

  describe('Documentation: Migration End-State', () => {
    it('documents the recommended configuration after full migration', () => {
      /**
       * After all users have migrated to BetterAuth (verified via
       * betterAuthMigrationStatus.canDisableLegacyAuth === true):
       *
       * 1. Set in config.env.ts:
       * ```typescript
       * auth: {
       *   legacyEndpoints: {
       *     enabled: false
       *   }
       * }
       * ```
       *
       * 2. Legacy endpoints will return:
       * - GraphQL: Error with message containing "disabled" and "BetterAuth"
       * - REST: HTTP 410 Gone
       *
       * 3. BetterAuth (IAM) endpoints continue to work normally
       *
       * 4. In a future major version, Legacy Auth code can be removed entirely
       */
      expect(true).toBe(true);
    });
  });
});
