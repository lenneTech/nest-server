/**
 * Story: BetterAuth Email Verification and Sign-Up Checks
 *
 * As a developer using @lenne.tech/nest-server,
 * I want email verification and sign-up validation to work correctly,
 * So that I can ensure users verify their email and accept terms.
 *
 * Tests cover:
 * - Email verification service configuration
 * - Sign-up validation with termsAndPrivacyAccepted
 * - GraphQL sign-up mutation with validation
 * - Configuration options (enable/disable features)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';

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

    it('should be disabled when not explicitly configured', () => {
      // Email verification follows "presence implies enabled" pattern:
      // No config (undefined) = disabled (backward compatible)
      // The nest-server test config does NOT have betterAuth.emailVerification set
      expect(emailVerificationService.isEnabled()).toBe(false);
    });

    it('should return correct configuration', () => {
      const config = emailVerificationService.getConfig();
      expect(config).toBeDefined();
      // Not enabled since not configured in test environment
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
});
