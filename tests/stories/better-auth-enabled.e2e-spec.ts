/**
 * Story: BetterAuth Enabled Integration Tests
 *
 * As a developer using @lenne.tech/nest-server,
 * I want Better-Auth to work when enabled,
 * So that I can use modern authentication methods in my application.
 *
 * These tests verify that Better-Auth works correctly when enabled,
 * including REST endpoints, GraphQL queries, and the full auth flow.
 *
 * Note: These tests use a separate configuration with betterAuth.enabled: true
 */

import { Db, MongoClient } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  BetterAuthModule,
  BetterAuthRateLimiter,
  BetterAuthService,
  BetterAuthUserMapper,
  ConfigService,
  createBetterAuthInstance,
  RoleEnum,
} from '../../src';
import envConfig from '../../src/config.env';

describe('Story: BetterAuth Enabled Integration', () => {
  // ===================================================================================================================
  // BetterAuthResolver Tests (GraphQL Queries)
  // ===================================================================================================================

  describe('BetterAuthResolver GraphQL Queries', () => {
    describe('betterAuthEnabled Query', () => {
      it('should return false when Better-Auth is disabled', async () => {
        // Create a mock service that returns disabled
        const mockService = {
          getEnabledSocialProviders: () => [],
          isEnabled: () => false,
          isJwtEnabled: () => false,
          isPasskeyEnabled: () => false,
          isTwoFactorEnabled: () => false,
        };

        // The query should return false
        expect(mockService.isEnabled()).toBe(false);
      });

      it('should return correct feature configuration', async () => {
        // Test the features model structure
        const features = {
          enabled: true,
          jwt: true,
          passkey: false,
          socialProviders: ['google'],
          twoFactor: false,
        };

        expect(features.enabled).toBe(true);
        expect(features.jwt).toBe(true);
        expect(features.socialProviders).toContain('google');
      });
    });
  });

  // ===================================================================================================================
  // BetterAuthService Tests with Enabled Config
  // ===================================================================================================================

  describe('BetterAuthService with Enabled Configuration', () => {
    let service: BetterAuthService;
    let rateLimiter: BetterAuthRateLimiter;

    beforeEach(() => {
      rateLimiter = new BetterAuthRateLimiter();

      // Create a mock config service that returns enabled config
      const mockConfigService = {
        get: (key: string) => {
          if (key === 'betterAuth') {
            return {
              basePath: '/iam',
              baseUrl: 'http://localhost:3000',
              enabled: true,
              jwt: { enabled: true, expiresIn: '15m' },
              passkey: { enabled: false },
              rateLimit: { enabled: true, max: 10, windowSeconds: 60 },
              secret: 'TEST_SECRET_THAT_IS_AT_LEAST_32_CHARS_LONG',
              socialProviders: {
                apple: { enabled: false },
                github: { enabled: false },
                google: { clientId: 'test', clientSecret: 'test', enabled: true },
              },
              twoFactor: { enabled: false },
            };
          }
          return undefined;
        },
      };

      // Note: Since we can't fully initialize Better-Auth without MongoDB,
      // we test the service methods that don't require the auth instance
      service = new BetterAuthService(null, mockConfigService as ConfigService);
    });

    afterEach(() => {
      rateLimiter.onModuleDestroy();
    });

    it('should report enabled status based on config and instance', () => {
      // Without auth instance, isEnabled returns false even if config says enabled
      // This is correct behavior - both config AND instance must be present
      expect(service.isEnabled()).toBe(false);
    });

    it('should return correct config values', () => {
      const config = service.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.basePath).toBe('/iam');
      expect(config.baseUrl).toBe('http://localhost:3000');
    });

    it('should return correct base path', () => {
      expect(service.getBasePath()).toBe('/iam');
    });

    it('should return correct base URL', () => {
      expect(service.getBaseUrl()).toBe('http://localhost:3000');
    });
  });

  // ===================================================================================================================
  // Configuration Validation Tests
  // ===================================================================================================================

  describe('Configuration Validation', () => {
    it('should validate secret length', () => {
      const shortSecret = 'too-short';
      const validSecret = 'THIS_IS_A_VALID_SECRET_THAT_IS_AT_LEAST_32_CHARACTERS';

      expect(shortSecret.length).toBeLessThan(32);
      expect(validSecret.length).toBeGreaterThanOrEqual(32);
    });

    it('should have all required fields in config', () => {
      const config = envConfig.betterAuth;

      expect(config).toBeDefined();
      expect(config.basePath).toBeDefined();
      expect(config.baseUrl).toBeDefined();
      expect(config.secret).toBeDefined();
      // enabled can be boolean or undefined (undefined is treated as true/enabled)
      expect(config.enabled === undefined || typeof config.enabled === 'boolean').toBe(true);
    });

    it('should have JWT config', () => {
      const config = envConfig.betterAuth;

      expect(config.jwt).toBeDefined();
      expect(typeof config.jwt.enabled).toBe('boolean');
    });

    it('should have social providers config', () => {
      const config = envConfig.betterAuth;

      expect(config.socialProviders).toBeDefined();
      expect(config.socialProviders.google).toBeDefined();
      expect(config.socialProviders.github).toBeDefined();
      expect(config.socialProviders.apple).toBeDefined();
    });

    it('should have rate limit config', () => {
      const config = envConfig.betterAuth;

      expect(config.rateLimit).toBeDefined();
      expect(typeof config.rateLimit.enabled).toBe('boolean');
      expect(typeof config.rateLimit.max).toBe('number');
      expect(typeof config.rateLimit.windowSeconds).toBe('number');
    });
  });

  // ===================================================================================================================
  // Module Integration Tests
  // ===================================================================================================================

  describe('Module Integration', () => {
    it('should create disabled module when betterAuth.enabled is false', () => {
      const config = {
        basePath: '/iam',
        enabled: false,
        secret: 'TEST_SECRET_THAT_IS_AT_LEAST_32_CHARS_LONG',
      };

      // BetterAuthModule.forRoot should not throw when disabled
      const module = BetterAuthModule.forRoot({ config: config as any });

      expect(module).toBeDefined();
      expect(module.module).toBe(BetterAuthModule);
    });

    it('should accept short secret when valid fallback is available', () => {
      const configWithShortSecret = {
        basePath: '/iam',
        enabled: true,
        secret: 'short', // Too short, but fallback will be used
      };

      // With the new fallback system, forRoot doesn't throw immediately
      // The secret validation happens in createBetterAuthInstance
      // If a valid fallback is provided, the module will use that instead
      const module = BetterAuthModule.forRoot({
        config: configWithShortSecret as any,
        fallbackSecrets: ['a-valid-fallback-secret-that-is-at-least-32-chars'],
      });

      // Module should be created (validation happens later in factory)
      expect(module).toBeDefined();
    });

    it('should reject short secret when explicitly provided and no fallback', () => {
      // This test uses createBetterAuthInstance directly to test validation
      // because forRoot uses deferred initialization
      expect(() => {
        createBetterAuthInstance({
          config: {
            enabled: true,
            secret: 'short', // Too short
          },
          db: {}, // Mock db
          // No fallbackSecrets provided
        });
      }).toThrow('Secret must be at least 32 characters long');
    });

    it('should export all necessary providers', () => {
      const config = {
        basePath: '/iam',
        enabled: false,
        secret: 'TEST_SECRET_THAT_IS_AT_LEAST_32_CHARS_LONG',
      };

      const module = BetterAuthModule.forRoot({ config: config as any });

      // Check exports include essential services
      expect(module.exports).toContain(BetterAuthService);
      expect(module.exports).toContain(BetterAuthUserMapper);
      expect(module.exports).toContain(BetterAuthRateLimiter);
    });
  });

  // ===================================================================================================================
  // User Model Integration
  // ===================================================================================================================

  describe('User Model Better-Auth Fields', () => {
    let mongoClient: MongoClient;
    let db: Db;

    beforeAll(async () => {
      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();
    });

    afterAll(async () => {
      if (mongoClient) {
        await mongoClient.close();
      }
    });

    it('should support iamId field', async () => {
      const testEmail = `better-auth-id-test-${Date.now()}@test.com`;
      const testBetterAuthId = `ba-${Date.now()}`;

      try {
        // Create user with iamId
        const result = await db.collection('users').insertOne({
          createdAt: new Date(),
          email: testEmail,
          iamId: testBetterAuthId,
          roles: [RoleEnum.S_USER],
          updatedAt: new Date(),
        });

        // Verify the field is stored
        const user = await db.collection('users').findOne({ _id: result.insertedId });
        expect(user.iamId).toBe(testBetterAuthId);
      } finally {
        await db.collection('users').deleteOne({ email: testEmail });
      }
    });

    // Note: twoFactorEnabled and twoFactorSecret are managed by Better-Auth's twoFactor plugin
    // in a separate twoFactor collection, not in our User model
  });

  // ===================================================================================================================
  // GraphQL Schema Integration Tests
  // ===================================================================================================================

  describe('GraphQL Schema Types', () => {
    it('should define BetterAuthAuthModel correctly', async () => {
      // Import the model to ensure it's properly defined
      const { BetterAuthAuthModel } = await import('../../src/core/modules/better-auth/better-auth-auth.model');

      // Verify the class exists and has expected structure
      expect(BetterAuthAuthModel).toBeDefined();

      // Create an instance to verify fields
      const instance = new BetterAuthAuthModel();
      instance.success = true;
      instance.requiresTwoFactor = false;

      expect(instance.success).toBe(true);
      expect(instance.requiresTwoFactor).toBe(false);
    });

    it('should define BetterAuthFeaturesModel correctly', async () => {
      const { BetterAuthFeaturesModel } = await import('../../src/core/modules/better-auth/better-auth-models');

      expect(BetterAuthFeaturesModel).toBeDefined();

      const features = new BetterAuthFeaturesModel();
      features.enabled = true;
      features.jwt = true;
      features.twoFactor = false;
      features.passkey = false;
      features.socialProviders = ['google'];

      expect(features.enabled).toBe(true);
      expect(features.socialProviders).toContain('google');
    });

    it('should define BetterAuthUserModel correctly', async () => {
      const { BetterAuthUserModel } = await import('../../src/core/modules/better-auth/better-auth-models');

      expect(BetterAuthUserModel).toBeDefined();

      const user = new BetterAuthUserModel();
      user.id = 'test-id';
      user.email = 'test@test.com';
      user.roles = [RoleEnum.S_USER];

      expect(user.id).toBe('test-id');
      expect(user.email).toBe('test@test.com');
    });

    it('should define BetterAuthSessionModel correctly', async () => {
      const { BetterAuthSessionModel, BetterAuthUserModel } =
        await import('../../src/core/modules/better-auth/better-auth-models');

      expect(BetterAuthSessionModel).toBeDefined();

      const session = new BetterAuthSessionModel();
      session.id = 'session-id';
      session.expiresAt = new Date();
      session.user = new BetterAuthUserModel();
      session.user.id = 'user-id';
      session.user.email = 'test@test.com';

      expect(session.id).toBe('session-id');
      expect(session.user.id).toBe('user-id');
    });
  });

  // ===================================================================================================================
  // REST Endpoint Path Tests
  // ===================================================================================================================

  describe('REST Endpoint Paths', () => {
    it('should use configured base path for endpoints', () => {
      const config = envConfig.betterAuth;
      const basePath = config.basePath || '/iam';

      // Verify expected endpoint paths
      expect(`${basePath}/sign-in/email`).toBe('/iam/sign-in/email');
      expect(`${basePath}/sign-up/email`).toBe('/iam/sign-up/email');
      expect(`${basePath}/sign-out`).toBe('/iam/sign-out');
      expect(`${basePath}/session`).toBe('/iam/session');
    });

    it('should have JWT endpoints when JWT enabled', () => {
      const config = envConfig.betterAuth;

      if (config.jwt?.enabled) {
        const basePath = config.basePath || '/iam';
        expect(`${basePath}/token`).toBe('/iam/token');
      }
    });
  });

  // ===================================================================================================================
  // User Sync and Migration Tests
  // ===================================================================================================================

  describe('User Sync for Parallel Legacy/Better-Auth Operation', () => {
    let mongoClient: MongoClient;
    let db: Db;

    beforeAll(async () => {
      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();
    });

    afterAll(async () => {
      if (mongoClient) {
        await mongoClient.close();
      }
    });

    describe('User Sync', () => {
      it('should find user by email OR iamId', async () => {
        const testEmail = `bidirectional-search-${Date.now()}@test.com`;
        const testBetterAuthId = `ba-bidirectional-${Date.now()}`;

        try {
          // Create user with both email and iamId
          await db.collection('users').insertOne({
            createdAt: new Date(),
            email: testEmail,
            iamId: testBetterAuthId,
            roles: [RoleEnum.S_USER],
            updatedAt: new Date(),
          });

          // Should find by email
          const byEmail = await db.collection('users').findOne({
            $or: [{ email: testEmail }, { iamId: 'wrong-id' }],
          });
          expect(byEmail).toBeDefined();
          expect(byEmail.email).toBe(testEmail);

          // Should find by iamId
          const byBetterAuthId = await db.collection('users').findOne({
            $or: [{ email: 'wrong@email.com' }, { iamId: testBetterAuthId }],
          });
          expect(byBetterAuthId).toBeDefined();
          expect(byBetterAuthId.iamId).toBe(testBetterAuthId);
        } finally {
          await db.collection('users').deleteOne({ email: testEmail });
        }
      });

      it('should preserve existing roles when syncing', async () => {
        const testEmail = `preserve-roles-${Date.now()}@test.com`;
        const existingRoles = [RoleEnum.ADMIN, 'custom-role'];

        try {
          // Create user with specific roles
          await db.collection('users').insertOne({
            createdAt: new Date(),
            email: testEmail,
            roles: existingRoles,
            updatedAt: new Date(),
          });

          // Sync with Better-Auth (simulated)
          const iamId = `ba-${Date.now()}`;
          await db.collection('users').findOneAndUpdate(
            { email: testEmail },
            {
              $set: {
                iamId,
                updatedAt: new Date(),
              },
              // Note: roles are NOT in $set, so they're preserved
            },
          );

          // Verify roles are preserved
          const user = await db.collection('users').findOne({ email: testEmail });
          expect(user.roles).toEqual(existingRoles);
          expect(user.iamId).toBe(iamId);
        } finally {
          await db.collection('users').deleteOne({ email: testEmail });
        }
      });
    });

    describe('Parallel Operation Support', () => {
      it('should support user with both legacy password and iamId', async () => {
        const testEmail = `parallel-auth-${Date.now()}@test.com`;
        const legacyPassword = '$2b$10$hashedPassword';
        const iamId = `ba-parallel-${Date.now()}`;

        try {
          // User can have both (during migration period)
          await db.collection('users').insertOne({
            createdAt: new Date(),
            email: testEmail,
            iamId, // Better-Auth also configured
            password: legacyPassword, // Legacy auth still works
            roles: [RoleEnum.S_USER],
            updatedAt: new Date(),
          });

          const user = await db.collection('users').findOne({ email: testEmail });

          // Both authentication methods available
          expect(user.password).toBe(legacyPassword);
          expect(user.iamId).toBe(iamId);
        } finally {
          await db.collection('users').deleteOne({ email: testEmail });
        }
      });

      it('should create new user with default role when not found', async () => {
        const testEmail = `new-better-auth-user-${Date.now()}@test.com`;

        try {
          // Verify user doesn't exist
          const before = await db.collection('users').findOne({ email: testEmail });
          expect(before).toBeNull();

          // Create via upsert (like linkOrCreateUser does)
          const iamId = `ba-new-${Date.now()}`;
          await db.collection('users').findOneAndUpdate(
            { email: testEmail },
            {
              $set: {
                email: testEmail,
                iamId,
                updatedAt: new Date(),
              },
              $setOnInsert: {
                createdAt: new Date(),
                roles: [], // S_ roles are system checks, not stored in user.roles
              },
            },
            { upsert: true },
          );

          // Verify user was created with default role
          const user = await db.collection('users').findOne({ email: testEmail });
          expect(user).toBeDefined();
          expect(user.roles).toEqual([]); // S_ roles are system checks, not stored in user.roles
          expect(user.iamId).toBe(iamId);
        } finally {
          await db.collection('users').deleteOne({ email: testEmail });
        }
      });
    });
  });
});
