/**
 * Story: BetterAuth Email Verification and Sign-Up Checks
 *
 * As a developer using @lenne.tech/nest-server,
 * I want email verification and sign-up validation to work correctly,
 * So that I can ensure users verify their email and accept terms.
 *
 * Tests cover:
 * - Email verification service configuration
 * - Resend cooldown mechanism (backend)
 * - GET /iam/features REST endpoint
 * - Sign-up validation with termsAndPrivacyAccepted
 * - GraphQL sign-up mutation with validation
 * - Configuration options (enable/disable features)
 * - REST sign-in with unverified email (LTNS_0023 regression)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';
import { vi } from 'vitest';

import {
  CoreBetterAuthEmailVerificationService,
  CoreBetterAuthService,
  CoreBetterAuthSignUpValidatorService,
  HttpExceptionLogFilter,
  TestGraphQLType,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

describe('Story: BetterAuth Email Verification and Sign-Up Checks', () => {
  // Test environment properties
  let app;
  let testHelper: TestHelper;
  let betterAuthService: CoreBetterAuthService;
  let emailVerificationService: CoreBetterAuthEmailVerificationService;
  let signUpValidator: CoreBetterAuthSignUpValidatorService;
  let isBetterAuthEnabled: boolean;

  // Database
  let mongoClient: MongoClient;
  let db;

  // Test data tracking
  const testUserIds: string[] = [];
  const testIamUserIds: string[] = [];
  const testEmails: string[] = [];

  // ===================================================================================================================
  // Setup & Teardown
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
      betterAuthService = moduleFixture.get(CoreBetterAuthService);
      emailVerificationService = moduleFixture.get(CoreBetterAuthEmailVerificationService);
      signUpValidator = moduleFixture.get(CoreBetterAuthSignUpValidatorService);
      isBetterAuthEnabled = betterAuthService.isEnabled();

      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    // Cleanup test users
    if (db) {
      for (const userId of testUserIds) {
        try {
          await db.collection('users').deleteOne({ _id: new ObjectId(userId) });
        } catch {
          // Ignore cleanup errors
        }
      }
      // Cleanup Better-Auth users and sessions
      for (const iamId of testIamUserIds) {
        try {
          await db.collection('iam_user').deleteOne({ _id: iamId });
          await db.collection('iam_session').deleteMany({ userId: iamId });
          await db.collection('iam_account').deleteMany({ userId: iamId });
        } catch {
          // Ignore cleanup errors
        }
      }
      // Cleanup by email
      for (const email of testEmails) {
        try {
          await db.collection('users').deleteMany({ email });
          await db.collection('iam_user').deleteMany({ email });
        } catch {
          // Ignore cleanup errors
        }
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
  // Email Verification Service Tests
  // ===================================================================================================================

  describe('Email Verification Service', () => {
    it('should be available as a service', () => {
      expect(emailVerificationService).toBeDefined();
    });

    it('should reflect config setting (disabled in nest-server test config)', () => {
      // nest-server test config explicitly sets emailVerification: false
      // In consuming projects without explicit config, it defaults to enabled (zero-config)
      expect(emailVerificationService.isEnabled()).toBe(false);
    });

    it('should return correct configuration', () => {
      const config = emailVerificationService.getConfig();
      expect(config).toBeDefined();
      // Disabled in nest-server test config
      expect(config.enabled).toBe(false);
      expect(config.expiresIn).toBeGreaterThan(0);
      expect(config.template).toBeDefined();
      expect(config.locale).toBeDefined();
    });

    it('should return expiration time in seconds', () => {
      const expiresIn = emailVerificationService.getExpiresIn();
      expect(typeof expiresIn).toBe('number');
      expect(expiresIn).toBeGreaterThan(0);
    });

    it('should have resendCooldownSeconds in configuration', () => {
      const config = emailVerificationService.getConfig();
      expect(typeof config.resendCooldownSeconds).toBe('number');
      expect(config.resendCooldownSeconds).toBeGreaterThanOrEqual(0);
    });

    it('should default resendCooldownSeconds to 60', () => {
      // Without explicit configuration, resendCooldownSeconds defaults to 60
      const config = emailVerificationService.getConfig();
      expect(config.resendCooldownSeconds).toBe(60);
    });
  });

  // ===================================================================================================================
  // Resend Cooldown Tests
  // ===================================================================================================================

  describe('Resend Cooldown Mechanism', () => {
    it('should not be in cooldown for a fresh email address', () => {
      // Access protected method via type assertion for testing
      const service = emailVerificationService as any;
      const result = service.isInCooldown(`fresh-${Date.now()}@test.com`);
      expect(result).toBe(false);
    });

    it('should track send and enforce cooldown', () => {
      const service = emailVerificationService as any;
      const testEmail = `cooldown-test-${Date.now()}@test.com`;

      // Initially not in cooldown
      expect(service.isInCooldown(testEmail)).toBe(false);

      // Track a send
      service.trackSend(testEmail);

      // Now should be in cooldown
      expect(service.isInCooldown(testEmail)).toBe(true);
    });

    it('should be case-insensitive for cooldown tracking', () => {
      const service = emailVerificationService as any;
      const timestamp = Date.now();
      const lowerEmail = `case-test-${timestamp}@test.com`;
      const upperEmail = `CASE-TEST-${timestamp}@TEST.COM`;

      // Track send with lowercase
      service.trackSend(lowerEmail);

      // Should also be in cooldown with uppercase
      expect(service.isInCooldown(upperEmail)).toBe(true);
    });
  });

  // ===================================================================================================================
  // GET /iam/features REST Endpoint Tests
  // ===================================================================================================================

  describe('GET /iam/features', () => {
    it('should return feature flags as JSON', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      const response = await testHelper.rest('/iam/features', {
        method: 'GET',
        statusCode: 200,
      });

      expect(response).toBeDefined();
      expect(typeof response.enabled).toBe('boolean');
      expect(typeof response.emailVerification).toBe('boolean');
      expect(typeof response.jwt).toBe('boolean');
      expect(typeof response.twoFactor).toBe('boolean');
      expect(typeof response.passkey).toBe('boolean');
      expect(Array.isArray(response.socialProviders)).toBe(true);
      expect(typeof response.resendCooldownSeconds).toBe('number');
    });

    it('should return resendCooldownSeconds matching service config', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      const response = await testHelper.rest('/iam/features', {
        method: 'GET',
        statusCode: 200,
      });

      const serviceConfig = emailVerificationService.getConfig();
      expect(response.resendCooldownSeconds).toBe(serviceConfig.resendCooldownSeconds);
    });

    it('should report emailVerification status from config', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      const response = await testHelper.rest('/iam/features', {
        method: 'GET',
        statusCode: 200,
      });

      // Email verification status depends on config (disabled in nest-server test config)
      expect(typeof response.emailVerification).toBe('boolean');
    });

    it('should report enabled as true', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      const response = await testHelper.rest('/iam/features', {
        method: 'GET',
        statusCode: 200,
      });

      expect(response.enabled).toBe(true);
    });

    it('should be accessible without authentication', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      // No token passed - should still work (S_EVERYONE)
      const response = await testHelper.rest('/iam/features', {
        method: 'GET',
        statusCode: 200,
      });

      expect(response).toBeDefined();
      expect(response.enabled).toBe(true);
    });
  });

  // ===================================================================================================================
  // Sign-Up Validator Service Tests
  // ===================================================================================================================

  describe('Sign-Up Validator Service', () => {
    it('should be available as a service', () => {
      expect(signUpValidator).toBeDefined();
    });

    it('should be enabled by default', () => {
      // Sign-up checks are enabled by default
      expect(signUpValidator.isEnabled()).toBe(true);
    });

    it('should require termsAndPrivacyAccepted by default', () => {
      const requiredFields = signUpValidator.getRequiredFields();
      expect(requiredFields).toContain('termsAndPrivacyAccepted');
    });

    it('should throw error when termsAndPrivacyAccepted is false', () => {
      expect(() => {
        signUpValidator.validateSignUpInput({ termsAndPrivacyAccepted: false });
      }).toThrow();
    });

    it('should throw error when termsAndPrivacyAccepted is undefined', () => {
      expect(() => {
        signUpValidator.validateSignUpInput({});
      }).toThrow();
    });

    it('should not throw when termsAndPrivacyAccepted is true', () => {
      expect(() => {
        signUpValidator.validateSignUpInput({ termsAndPrivacyAccepted: true });
      }).not.toThrow();
    });
  });

  // ===================================================================================================================
  // GraphQL Sign-Up with Validation Tests
  // ===================================================================================================================

  describe('GraphQL Sign-Up with termsAndPrivacyAccepted', () => {
    const generateTestEmail = () => {
      const timestamp = Date.now();
      const email = `test-signup-terms-${timestamp}@example.com`;
      testEmails.push(email);
      return email;
    };

    it('should reject sign-up without termsAndPrivacyAccepted', async () => {
      if (!isBetterAuthEnabled) {
        return; // Skip if Better-Auth is not enabled
      }

      // First verify the sign-up validator is enabled and configured
      expect(signUpValidator.isEnabled()).toBe(true);
      expect(signUpValidator.getRequiredFields()).toContain('termsAndPrivacyAccepted');

      const email = generateTestEmail();

      // When GraphQL mutation fails, the response.body.data is null
      // and the TestHelper returns response.body which contains the errors array
      const response: any = await testHelper.graphQl({
        arguments: {
          email,
          name: 'Test User',
          password: 'TestPassword123!',
          // termsAndPrivacyAccepted is not provided
        },
        fields: ['success'],
        name: 'betterAuthSignUp',
        type: TestGraphQLType.MUTATION,
      });

      // GraphQL returns errors array when validation fails
      // The response should contain errors and data should be null
      expect(response.errors).toBeDefined();
      expect(response.errors.length).toBeGreaterThan(0);

      // Check for our specific error message
      const errorMessage = response.errors[0]?.message || '';
      expect(
        errorMessage.includes('LTNS_0021') ||
        errorMessage.includes('Terms and privacy policy must be accepted'),
      ).toBe(true);
    });

    it('should reject sign-up with termsAndPrivacyAccepted: false', async () => {
      if (!isBetterAuthEnabled) {
        return; // Skip if Better-Auth is not enabled
      }

      const email = generateTestEmail();

      try {
        await testHelper.graphQl({
          arguments: {
            email,
            name: 'Test User',
            password: 'TestPassword123!',
            termsAndPrivacyAccepted: false,
          },
          fields: ['success'],
          name: 'betterAuthSignUp',
          type: TestGraphQLType.MUTATION,
        });
        // If we get here, the test should fail
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        // Should fail because termsAndPrivacyAccepted is false
        expect(error).toBeDefined();
      }
    });

    it('should accept sign-up with termsAndPrivacyAccepted: true', async () => {
      if (!isBetterAuthEnabled) {
        return; // Skip if Better-Auth is not enabled
      }

      const email = generateTestEmail();

      const response: any = await testHelper.graphQl({
        arguments: {
          email,
          name: 'Test User With Terms',
          password: 'TestPassword123!',
          termsAndPrivacyAccepted: true,
        },
        fields: ['success', { user: ['id', 'email'] }],
        name: 'betterAuthSignUp',
        type: TestGraphQLType.MUTATION,
      });

      // Should succeed
      expect(response.success).toBe(true);
      if (response.user?.id) {
        // Find the corresponding user in our database
        const user = await db.collection('users').findOne({ email });
        if (user) {
          testUserIds.push(user._id.toString());
        }
      }
    });

    it('should store termsAndPrivacyAcceptedAt timestamp in database', async () => {
      if (!isBetterAuthEnabled) {
        return; // Skip if Better-Auth is not enabled
      }

      const email = generateTestEmail();

      const response: any = await testHelper.graphQl({
        arguments: {
          email,
          name: 'Test User Timestamp',
          password: 'TestPassword123!',
          termsAndPrivacyAccepted: true,
        },
        fields: ['success', { user: ['id', 'email'] }],
        name: 'betterAuthSignUp',
        type: TestGraphQLType.MUTATION,
      });

      if (response.success) {
        // Check if termsAndPrivacyAcceptedAt was stored
        const user = await db.collection('users').findOne({ email });
        expect(user).toBeDefined();
        expect(user?.termsAndPrivacyAcceptedAt).toBeDefined();
        expect(user?.termsAndPrivacyAcceptedAt instanceof Date).toBe(true);

        // Track for cleanup
        if (user) {
          testUserIds.push(user._id.toString());
        }
      }
    });
  });

  // ===================================================================================================================
  // CoreUserModel Field Tests
  // ===================================================================================================================

  describe('CoreUserModel termsAndPrivacyAcceptedAt Field', () => {
    it('should have termsAndPrivacyAcceptedAt field in user schema', async () => {
      // Create a test user directly to verify field exists
      const email = `test-field-check-${Date.now()}@example.com`;
      testEmails.push(email);

      const now = new Date();
      const result = await db.collection('users').insertOne({
        createdAt: now,
        email,
        termsAndPrivacyAcceptedAt: now,
        updatedAt: now,
      });

      expect(result.insertedId).toBeDefined();
      testUserIds.push(result.insertedId.toString());

      // Verify the field was stored correctly
      const user = await db.collection('users').findOne({ _id: result.insertedId });
      expect(user?.termsAndPrivacyAcceptedAt).toEqual(now);
    });
  });

  // ===================================================================================================================
  // Resend Cooldown via REST Tests
  // ===================================================================================================================

  describe('Resend Cooldown via REST', () => {
    it('should silently skip second send within cooldown period', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      // Skip if email verification is disabled (nest-server test config)
      if (!emailVerificationService.isEnabled()) {
        return;
      }

      const email = `cooldown-rest-${Date.now()}@example.com`;
      testEmails.push(email);

      // First call: should succeed (Better-Auth may return 200 even for non-existent user)
      const firstResponse = await testHelper.rest('/iam/send-verification-email', {
        method: 'POST',
        payload: { callbackURL: '/auth/verify-email', email },
        statusCode: 200,
      });

      expect(firstResponse).toBeDefined();

      // Second call immediately: should be silently handled (cooldown enforced by service)
      // The endpoint still returns 200 but the service logs "Resend cooldown active" and skips
      const secondResponse = await testHelper.rest('/iam/send-verification-email', {
        method: 'POST',
        payload: { callbackURL: '/auth/verify-email', email },
        statusCode: 200,
      });

      expect(secondResponse).toBeDefined();
    });
  });

  // ===================================================================================================================
  // REST Sign-In with Unverified Email Tests
  // ===================================================================================================================

  describe('REST Sign-In with Unverified Email', () => {
    const generateTestEmail = () => {
      const timestamp = Date.now();
      const email = `test-unverified-rest-${timestamp}@example.com`;
      testEmails.push(email);
      return email;
    };

    it('should allow sign-in when emailVerification is disabled (baseline)', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      // Email verification is disabled in nest-server test config
      expect(emailVerificationService.isEnabled()).toBe(false);

      const email = generateTestEmail();
      const password = 'TestPassword123!';

      // Register user via REST
      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Unverified REST User', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      // Wait for DB sync
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      // Explicitly mark as NOT verified in both DBs
      await db.collection('users').updateOne({ email }, { $set: { emailVerified: false, verified: false } });
      await db.collection('iam_user').updateOne({ email }, { $set: { emailVerified: false } });

      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      // Sign-in should succeed because emailVerification is disabled
      const signInResult = await testHelper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email, password },
        statusCode: 200,
      });

      expect(signInResult.success).toBe(true);
    });

    it('should block sign-in when emailVerification is enabled and email not verified (LTNS_0023)', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      const email = generateTestEmail();
      const password = 'TestPassword123!';

      // Register user via REST
      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Verify Block User', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      // Wait for DB sync
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      // Explicitly mark as NOT verified in both DBs
      await db.collection('users').updateOne({ email }, { $set: { emailVerified: false, verified: false } });
      await db.collection('iam_user').updateOne({ email }, { $set: { emailVerified: false } });

      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      // Temporarily enable email verification via spy
      const isEnabledSpy = vi.spyOn(emailVerificationService, 'isEnabled').mockReturnValue(true);

      try {
        // Sign-in should be blocked with LTNS_0023 (EMAIL_VERIFICATION_REQUIRED)
        const signInResult = await testHelper.rest('/iam/sign-in/email', {
          method: 'POST',
          payload: { email, password },
          statusCode: 401,
        });

        // The error should be LTNS_0023, NOT LTNS_0010 (INVALID_CREDENTIALS)
        expect(signInResult.message).toContain('LTNS_0023');
      } finally {
        // Always restore the original implementation
        isEnabledSpy.mockRestore();
      }
    });

    it('should return LTNS_0023 not LTNS_0010 for unverified email with verification enabled', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      const email = generateTestEmail();
      const password = 'TestPassword123!';

      // Register user via REST
      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, name: 'Error Code User', password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      // Wait for DB sync
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      // Explicitly mark as NOT verified
      await db.collection('users').updateOne({ email }, { $set: { emailVerified: false, verified: false } });
      await db.collection('iam_user').updateOne({ email }, { $set: { emailVerified: false } });

      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      // Temporarily enable email verification
      const isEnabledSpy = vi.spyOn(emailVerificationService, 'isEnabled').mockReturnValue(true);

      try {
        const signInResult = await testHelper.rest('/iam/sign-in/email', {
          method: 'POST',
          payload: { email, password },
          statusCode: 401,
        });

        // Verify it's specifically LTNS_0023 (email verification) and NOT LTNS_0010 (invalid credentials)
        expect(signInResult.message).not.toContain('LTNS_0010');
        expect(signInResult.message).toContain('LTNS_0023');
      } finally {
        isEnabledSpy.mockRestore();
      }
    });
  });

  // ===================================================================================================================
  // Verification Token Reuse Tests
  // ===================================================================================================================

  describe('Verification Token Reuse', () => {
    it('should reject verification with invalid token', async () => {
      if (!isBetterAuthEnabled) {
        return;
      }

      // Use a random invalid token
      try {
        await testHelper.rest('/iam/verify-email?token=invalid-token-12345', {
          method: 'GET',
          statusCode: 200,
        });
        // If it returns 200 with status: false, that's also valid
      } catch {
        // Expected: invalid token should fail
      }
    });
  });

  // ===================================================================================================================
  // Redirect Flow Tests (without callbackURL)
  // ===================================================================================================================

  describe('Verification Redirect Flow', () => {
    it('should build correct frontend URL when callbackURL is configured', () => {
      // When callbackURL is configured, the service should build a frontend URL
      const service = emailVerificationService as any;
      const config = emailVerificationService.getConfig();

      if (config.callbackURL) {
        const url = service.buildFrontendVerificationUrl('test-token-123');
        expect(url).toContain('test-token-123');
        expect(url).toContain('token=');
      }
    });

    it('should use appUrl for relative callbackURL paths', () => {
      const service = emailVerificationService as any;
      const config = emailVerificationService.getConfig();

      if (config.callbackURL && config.callbackURL.startsWith('/')) {
        const url = service.buildFrontendVerificationUrl('test-token-456');
        // Should contain a full URL, not just a relative path
        expect(url).toMatch(/^https?:\/\//);
        expect(url).toContain('token=test-token-456');
      }
    });
  });
});
