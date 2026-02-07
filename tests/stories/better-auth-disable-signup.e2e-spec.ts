/**
 * Story: BetterAuth disableSignUp Feature
 *
 * This test verifies the emailAndPassword.disableSignUp configuration:
 * - When disableSignUp: true, all sign-up endpoints (REST + GraphQL) return errors
 * - Sign-in endpoints still work (respond with credential errors, not "disabled" errors)
 * - The features endpoint reports signUpEnabled: false
 *
 * Use case: Invite-only apps, admin-created accounts
 *
 * Note: Positive sign-in tests with valid credentials are covered by
 * better-auth-api.story.test.ts. Here we only verify that sign-in endpoints
 * respond correctly (not blocked by disableSignUp).
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CoreBetterAuthModule,
  CoreBetterAuthService,
  CoreModule,
  HttpExceptionLogFilter,
  TestGraphQLType,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { Any } from '../../src/core/common/scalars/any.scalar';
import { DateScalar } from '../../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../../src/core/common/scalars/json.scalar';
import { CronJobs } from '../../src/server/common/services/cron-jobs.service';
import { BetterAuthModule } from '../../src/server/modules/better-auth/better-auth.module';
import { FileModule } from '../../src/server/modules/file/file.module';
import { ServerController } from '../../src/server/server.controller';

// Config: Sign-up disabled via emailAndPassword.disableSignUp
const disableSignUpConfig = {
  ...envConfig,
  auth: {
    ...envConfig.auth,
    legacyEndpoints: {
      enabled: false,
    },
  },
  betterAuth: {
    ...envConfig.betterAuth,
    emailAndPassword: {
      ...envConfig.betterAuth?.emailAndPassword,
      disableSignUp: true,
    },
    enabled: true,
  },
};

/**
 * Test Module: BetterAuth with sign-up disabled
 */
@Module({
  controllers: [ServerController],
  exports: [CoreModule, BetterAuthModule, FileModule],
  imports: [
    CoreModule.forRoot(disableSignUpConfig),
    ScheduleModule.forRoot(),
    BetterAuthModule.forRoot({
      config: disableSignUpConfig.betterAuth,
      fallbackSecrets: [disableSignUpConfig.jwt?.secret, disableSignUpConfig.jwt?.refresh?.secret],
      serverAppUrl: disableSignUpConfig.appUrl,
      serverBaseUrl: disableSignUpConfig.baseUrl,
      serverEnv: disableSignUpConfig.env,
    }),
    FileModule,
  ],
  providers: [Any, CronJobs, DateScalar, JSONScalar],
})
class DisableSignUpTestModule {}

describe('Story: BetterAuth disableSignUp', () => {
  let app;
  let testHelper: TestHelper;
  let betterAuthService: CoreBetterAuthService;

  // Test data tracking for cleanup
  const testEmails: string[] = [];

  // Helper to generate unique test emails
  const generateTestEmail = (prefix: string): string => {
    const email = `disable-signup-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    testEmails.push(email);
    return email;
  };

  // ===================================================================================================================
  // Setup and Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [DisableSignUpTestModule],
      providers: [{ provide: 'PUB_SUB', useValue: new PubSub() }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(disableSignUpConfig.templates.path);
    app.setViewEngine(disableSignUpConfig.templates.engine);
    await app.init();
    testHelper = new TestHelper(app);

    betterAuthService = moduleFixture.get(CoreBetterAuthService);
  });

  afterAll(async () => {
    if (app) await app.close();

    CoreBetterAuthModule.reset();
  });

  // ===================================================================================================================
  // Service State
  // ===================================================================================================================

  describe('Service State', () => {
    it('should have BetterAuth enabled', () => {
      expect(betterAuthService.isEnabled()).toBe(true);
    });

    it('should report sign-up as disabled', () => {
      expect(betterAuthService.isSignUpEnabled()).toBe(false);
    });
  });

  // ===================================================================================================================
  // Features Endpoint
  // ===================================================================================================================

  describe('Features Endpoint', () => {
    it('should report signUpEnabled: false via GraphQL', async () => {
      const result = await testHelper.graphQl({
        fields: ['enabled', 'signUpEnabled'],
        name: 'betterAuthFeatures',
        type: TestGraphQLType.QUERY,
      });

      expect(result.enabled).toBe(true);
      expect(result.signUpEnabled).toBe(false);
    });

    it('should report signUpEnabled: false via REST', async () => {
      const result = await testHelper.rest('/iam/features', {
        method: 'GET',
        statusCode: 200,
      });

      expect(result.enabled).toBe(true);
      expect(result.signUpEnabled).toBe(false);
    });
  });

  // ===================================================================================================================
  // Sign-Up Blocked
  // ===================================================================================================================

  describe('Sign-Up Blocked', () => {
    it('should reject REST sign-up with 400 and SIGNUP_DISABLED error', async () => {
      const email = generateTestEmail('rest-blocked');

      const result: any = await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Blocked User', password: 'TestPassword123!', termsAndPrivacyAccepted: true },
        statusCode: 400,
      });

      expect(result.message).toContain('LTNS_0026');
      expect(result.message.toLowerCase()).toContain('sign-up');
    });

    it('should reject GraphQL sign-up with SIGNUP_DISABLED error', async () => {
      const email = generateTestEmail('graphql-blocked');

      const result = await testHelper.graphQl(
        {
          arguments: { email, name: 'Blocked User', password: 'TestPassword123!', termsAndPrivacyAccepted: true },
          fields: ['success'],
          name: 'betterAuthSignUp',
          type: TestGraphQLType.MUTATION,
        },
        { statusCode: 200 },
      );

      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain('LTNS_0026');
    });

    it('should not create user in database when sign-up is blocked', async () => {
      const email = generateTestEmail('no-user');
      const password = 'TestPassword123!';

      // Attempt sign-up (will fail with LTNS_0026)
      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'No User', password, termsAndPrivacyAccepted: true },
        statusCode: 400,
      });

      // Verify no user was created: sign-in with same credentials should fail with 401
      const signInResult: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 401,
      });
      expect(signInResult.message).not.toContain('LTNS_0026');
    });
  });

  // ===================================================================================================================
  // Sign-In Still Works (Endpoint Not Blocked by disableSignUp)
  // ===================================================================================================================

  describe('Sign-In Still Works', () => {
    it('should return 401 for invalid credentials via REST (not "disabled" error)', async () => {
      const result: any = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: 'nonexistent@test.com', password: 'WrongPassword123!' },
        statusCode: 401,
      });

      // Sign-in returns a credential error, NOT a "sign-up disabled" error
      // This proves the sign-in endpoint is active and not affected by disableSignUp
      expect(result.message).not.toContain('LTNS_0026');
    });

    it('should return error for invalid credentials via GraphQL (not "disabled" error)', async () => {
      const result = await testHelper.graphQl(
        {
          arguments: { email: 'nonexistent@test.com', password: 'WrongPassword123!' },
          fields: ['success', { user: ['email'] }],
          name: 'betterAuthSignIn',
          type: TestGraphQLType.MUTATION,
        },
        { statusCode: 200 },
      );

      // GraphQL sign-in should return an error for invalid credentials, not a disabled error
      if (result.errors) {
        expect(result.errors[0].message).not.toContain('LTNS_0026');
      } else {
        // If betterAuthSignIn returns data instead of errors, success should be false
        expect(result.success).toBeFalsy();
      }
    });
  });
});
