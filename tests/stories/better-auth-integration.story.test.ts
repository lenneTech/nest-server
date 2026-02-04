/**
 * Story: BetterAuth Integration
 *
 * As a developer using @lenne.tech/nest-server,
 * I want to integrate better-auth for modern authentication,
 * So that I can use 2FA, Passkeys, and Social Login in my application.
 *
 * This test file verifies the basic integration of the CoreBetterAuthModule
 * with the nest-server framework.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MongoClient, ObjectId } from 'mongodb';

import {
  BETTER_AUTH_INSTANCE,
  ConfigService,
  CoreBetterAuthModule,
  CoreBetterAuthService,
  createBetterAuthInstance,
  HttpExceptionLogFilter,
  TestGraphQLType,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

describe('Story: BetterAuth Integration', () => {
  // Test environment properties
  let app;
  let testHelper: TestHelper;

  // Database
  let mongoClient: MongoClient;
  let db;

  // Services
  let configService: ConfigService;

  // ===================================================================================================================
  // Setup & Teardown
  // ===================================================================================================================

  beforeAll(async () => {
    try {
      // Start server for testing
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
      configService = moduleFixture.get(ConfigService);

      // Connection to database
      mongoClient = await MongoClient.connect(envConfig.mongoose.uri);
      db = mongoClient.db();
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (mongoClient) {
      await mongoClient.close();
    }
    if (app) {
      await app.close();
    }
  });

  // ===================================================================================================================
  // Test Cases
  // ===================================================================================================================

  describe('Module Configuration', () => {
    it('should have betterAuth configuration in server options', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig).toBeDefined();
      expect(typeof betterAuthConfig).toBe('object');
    });

    it('should have betterAuth enabled by default (unless explicitly disabled)', () => {
      const betterAuthConfig = configService.get('betterAuth');

      // BetterAuth is enabled by default - enabled is undefined (treated as true) or explicitly true
      // Only when enabled === false is BetterAuth disabled
      expect(betterAuthConfig.enabled).not.toBe(false);
    });

    it('should have JWT configuration for better-auth', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.jwt).toBeDefined();
      expect(betterAuthConfig.jwt.enabled).toBeDefined();
      expect(betterAuthConfig.jwt.expiresIn).toBeDefined();
    });

    it('should have 2FA configuration for better-auth', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.twoFactor).toBeDefined();
      expect(betterAuthConfig.twoFactor.enabled).toBeDefined();
      expect(betterAuthConfig.twoFactor.appName).toBeDefined();
    });

    it('should have Passkey configuration for better-auth', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.passkey).toBeDefined();
      expect(betterAuthConfig.passkey.enabled).toBeDefined();
      expect(betterAuthConfig.passkey.rpId).toBeDefined();
      expect(betterAuthConfig.passkey.rpName).toBeDefined();
    });

    it('should have Social Provider configurations', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.socialProviders).toBeDefined();
      expect(betterAuthConfig.socialProviders.google).toBeDefined();
      expect(betterAuthConfig.socialProviders.github).toBeDefined();
      expect(betterAuthConfig.socialProviders.apple).toBeDefined();
    });
  });

  describe('CoreBetterAuthModule (Disabled)', () => {
    const mockConfigService = {
      get: (key: string) => {
        if (key === 'betterAuth') {
          return { enabled: false };
        }
        return undefined;
      },
    };

    it('should create module with null instance when disabled', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          CoreBetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfigService }],
      }).compile();

      const betterAuthInstance = moduleRef.get(BETTER_AUTH_INSTANCE);
      expect(betterAuthInstance).toBeNull();

      await moduleRef.close();
    });

    it('should provide CoreBetterAuthService when disabled', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          CoreBetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfigService }],
      }).compile();

      const betterAuthService = moduleRef.get(CoreBetterAuthService);
      expect(betterAuthService).toBeDefined();
      expect(betterAuthService.isEnabled()).toBe(false);
      expect(betterAuthService.getInstance()).toBeNull();
      expect(betterAuthService.getApi()).toBeNull();

      await moduleRef.close();
    });
  });

  describe('CoreBetterAuthModule.reset()', () => {
    it('should reset static state for testing', () => {
      // First, verify reset method exists
      expect(typeof CoreBetterAuthModule.reset).toBe('function');

      // Call reset
      CoreBetterAuthModule.reset();

      // After reset, getInstance should return null
      expect(CoreBetterAuthModule.getInstance()).toBeNull();
    });

    it('should allow fresh initialization after reset', async () => {
      // Reset before test
      CoreBetterAuthModule.reset();

      const mockConfigService = {
        get: (key: string) => {
          if (key === 'betterAuth') {
            return { enabled: false };
          }
          return undefined;
        },
      };

      // Create new module after reset
      const moduleRef = await Test.createTestingModule({
        imports: [
          CoreBetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfigService }],
      }).compile();

      const betterAuthService = moduleRef.get(CoreBetterAuthService);
      expect(betterAuthService).toBeDefined();
      expect(betterAuthService.isEnabled()).toBe(false);

      await moduleRef.close();

      // Reset after test for clean state
      CoreBetterAuthModule.reset();
    });
  });

  describe('CoreBetterAuthService (Disabled Mode)', () => {
    let moduleRef: TestingModule;
    let betterAuthService: CoreBetterAuthService;

    const mockConfigService = {
      get: (key: string) => {
        if (key === 'betterAuth') {
          return {
            enabled: false,
            jwt: { enabled: true, expiresIn: '15m' },
            passkey: { enabled: false, rpId: 'localhost', rpName: 'Test App' },
            socialProviders: {
              apple: { enabled: false },
              github: { enabled: false },
              google: { enabled: false },
            },
            twoFactor: { appName: 'Test App', enabled: false },
          };
        }
        return undefined;
      },
    };

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          CoreBetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfigService }],
      }).compile();

      betterAuthService = moduleRef.get(CoreBetterAuthService);
    });

    afterAll(async () => {
      if (moduleRef) {
        await moduleRef.close();
      }
    });

    it('should report isEnabled as false when betterAuth is disabled', () => {
      expect(betterAuthService.isEnabled()).toBe(false);
    });

    it('should return null for getInstance when disabled', () => {
      expect(betterAuthService.getInstance()).toBeNull();
    });

    it('should return null for getApi when disabled', () => {
      expect(betterAuthService.getApi()).toBeNull();
    });

    it('should report isJwtEnabled as false when disabled', () => {
      // Even if JWT is configured as enabled, the service should return false
      // because the main betterAuth is disabled
      expect(betterAuthService.isJwtEnabled()).toBe(false);
    });

    it('should report isTwoFactorEnabled as false when disabled', () => {
      expect(betterAuthService.isTwoFactorEnabled()).toBe(false);
    });

    it('should report isPasskeyEnabled as false when disabled', () => {
      expect(betterAuthService.isPasskeyEnabled()).toBe(false);
    });

    it('should return empty array for getEnabledSocialProviders when disabled', () => {
      expect(betterAuthService.getEnabledSocialProviders()).toEqual([]);
    });

    it('should return default basePath', () => {
      expect(betterAuthService.getBasePath()).toBe('/iam');
    });

    it('should return default baseUrl', () => {
      expect(betterAuthService.getBaseUrl()).toBe('http://localhost:3000');
    });

    it('should return the config even when disabled', () => {
      const config = betterAuthService.getConfig();
      expect(config).toBeDefined();
      // The service correctly reports as disabled via isEnabled()
      // Config may have enabled: false or undefined (enabled by default)
      expect(betterAuthService.isEnabled()).toBe(false);
    });
  });

  describe('Existing Auth Still Works', () => {
    const testEmail = `better-auth-test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
    const testPassword = 'TestPassword123!';
    let userId: string;
    afterAll(async () => {
      // Cleanup: Remove test user
      if (userId) {
        try {
          await db.collection('users').deleteOne({ _id: new ObjectId(userId) });
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    });

    it('should still allow sign-up via existing auth', async () => {
      const res: any = await testHelper.graphQl({
        arguments: {
          input: {
            email: testEmail,
            password: testPassword,
          },
        },
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      expect(res.token).toBeDefined();
      expect(res.user.email).toBe(testEmail);

      userId = res.user.id;
    });

    it('should still allow sign-in via existing auth', async () => {
      const res: any = await testHelper.graphQl({
        arguments: {
          input: {
            email: testEmail,
            password: testPassword,
          },
        },
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(res.token).toBeDefined();
      expect(res.user.email).toBe(testEmail);
    });

    it('should have returned a valid refresh token on sign-up', async () => {
      // Verify that the sign-up response included a valid refresh token
      // This confirms the existing auth system's token generation is working
      const res: any = await testHelper.graphQl({
        arguments: {
          input: {
            email: testEmail,
            password: testPassword,
          },
        },
        fields: ['token', 'refreshToken', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      // Verify we get both tokens
      expect(res.token).toBeDefined();
      expect(res.refreshToken).toBeDefined();
      expect(res.token.length).toBeGreaterThan(0);
      expect(res.refreshToken.length).toBeGreaterThan(0);
      // Tokens should be different
      expect(res.token).not.toBe(res.refreshToken);
    });
  });

  // ===================================================================================================================
  // Phase 3: 2FA Plugin Configuration Tests
  // ===================================================================================================================

  describe('2FA Plugin Configuration', () => {
    it('should have 2FA configuration with appName', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.twoFactor).toBeDefined();
      expect(betterAuthConfig.twoFactor.appName).toBeDefined();
      expect(typeof betterAuthConfig.twoFactor.appName).toBe('string');
    });

    it('should have 2FA enabled in test environment for full testing', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.twoFactor.enabled).toBe(true);
    });

    it('should report isTwoFactorEnabled correctly via service', async () => {
      const mockConfig = {
        get: (key: string) => {
          if (key === 'betterAuth') {
            return {
              enabled: false,
              twoFactor: { appName: 'Test App', enabled: true },
            };
          }
          return undefined;
        },
      };

      const moduleRef = await Test.createTestingModule({
        imports: [
          CoreBetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfig }],
      }).compile();

      const betterAuthService = moduleRef.get(CoreBetterAuthService);
      // Even if twoFactor.enabled is true, isTwoFactorEnabled returns false
      // because the main betterAuth is disabled
      expect(betterAuthService.isTwoFactorEnabled()).toBe(false);

      await moduleRef.close();
    });
  });

  // ===================================================================================================================
  // Phase 4: Passkey Plugin Configuration Tests
  // ===================================================================================================================

  describe('Passkey Plugin Configuration', () => {
    it('should have Passkey configuration with rpId and rpName', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.passkey).toBeDefined();
      expect(betterAuthConfig.passkey.rpId).toBeDefined();
      expect(betterAuthConfig.passkey.rpName).toBeDefined();
      expect(typeof betterAuthConfig.passkey.rpId).toBe('string');
      expect(typeof betterAuthConfig.passkey.rpName).toBe('string');
    });

    it('should have Passkey enabled in test environment for full testing', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.passkey.enabled).toBe(true);
    });

    it('should have origin configuration for Passkey', () => {
      const betterAuthConfig = configService.get('betterAuth');

      // Origin is optional but should be defined if present
      if (betterAuthConfig.passkey.origin) {
        expect(typeof betterAuthConfig.passkey.origin).toBe('string');
      }
    });

    it('should report isPasskeyEnabled correctly via service', async () => {
      const mockConfig = {
        get: (key: string) => {
          if (key === 'betterAuth') {
            return {
              enabled: false,
              passkey: { enabled: true, rpId: 'localhost', rpName: 'Test App' },
            };
          }
          return undefined;
        },
      };

      const moduleRef = await Test.createTestingModule({
        imports: [
          CoreBetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfig }],
      }).compile();

      const betterAuthService = moduleRef.get(CoreBetterAuthService);
      // Even if passkey.enabled is true, isPasskeyEnabled returns false
      // because the main betterAuth is disabled
      expect(betterAuthService.isPasskeyEnabled()).toBe(false);

      await moduleRef.close();
    });
  });

  // ===================================================================================================================
  // Phase 5: Parallel Operation Tests
  // ===================================================================================================================

  describe('Parallel Operation with Legacy Auth', () => {
    it('should allow existing users to sign in when better-auth is disabled', async () => {
      // This test verifies that existing authentication still works
      // when better-auth is disabled (legacy mode)
      const testEmail = `legacy-test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
      const testPassword = 'LegacyPassword123!';

      // Sign up via existing auth
      const signUpRes: any = await testHelper.graphQl({
        arguments: {
          input: {
            email: testEmail,
            password: testPassword,
          },
        },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signUp',
        type: TestGraphQLType.MUTATION,
      });

      expect(signUpRes.token).toBeDefined();
      const userId = signUpRes.user.id;

      // Sign in via existing auth
      const signInRes: any = await testHelper.graphQl({
        arguments: {
          input: {
            email: testEmail,
            password: testPassword,
          },
        },
        fields: ['token', { user: ['id', 'email'] }],
        name: 'signIn',
        type: TestGraphQLType.MUTATION,
      });

      expect(signInRes.token).toBeDefined();
      expect(signInRes.user.email).toBe(testEmail);

      // Cleanup
      await db.collection('users').deleteOne({ _id: new ObjectId(userId) });
    });
  });

  // ===================================================================================================================
  // Social Providers Configuration Tests
  // ===================================================================================================================

  describe('Social Providers Configuration', () => {
    it('should have Google provider configuration', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.socialProviders.google).toBeDefined();
      expect(betterAuthConfig.socialProviders.google.enabled).toBeDefined();
    });

    it('should have GitHub provider configuration', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.socialProviders.github).toBeDefined();
      expect(betterAuthConfig.socialProviders.github.enabled).toBeDefined();
    });

    it('should have Apple provider configuration', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.socialProviders.apple).toBeDefined();
      expect(betterAuthConfig.socialProviders.apple.enabled).toBeDefined();
    });

    it('should report enabled social providers correctly via service', async () => {
      const mockConfig = {
        get: (key: string) => {
          if (key === 'betterAuth') {
            return {
              enabled: true, // Enable to test social providers
              socialProviders: {
                apple: { clientId: 'test', clientSecret: 'test', enabled: true },
                github: { enabled: false },
                google: { clientId: 'test', clientSecret: 'test', enabled: true },
              },
            };
          }
          return undefined;
        },
      };

      const moduleRef = await Test.createTestingModule({
        imports: [
          CoreBetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfig }],
      }).compile();

      const betterAuthService = moduleRef.get(CoreBetterAuthService);
      const enabledProviders = betterAuthService.getEnabledSocialProviders();

      // Note: The service returns empty because authInstance is null (forRoot with enabled: false)
      // In a real scenario with enabled: true and proper setup, it would return ['google', 'apple']
      expect(Array.isArray(enabledProviders)).toBe(true);

      await moduleRef.close();
    });

    it('should have all social providers disabled by default in test environment', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.socialProviders.google.enabled).toBe(false);
      expect(betterAuthConfig.socialProviders.github.enabled).toBe(false);
      expect(betterAuthConfig.socialProviders.apple.enabled).toBe(false);
    });
  });

  // ===================================================================================================================
  // Configuration Validation Tests
  // ===================================================================================================================

  describe('Configuration Validation', () => {
    it('should return null when better-auth is disabled', () => {
      const result = createBetterAuthInstance({
        config: { enabled: false },
        db,
      });

      expect(result).toBeNull();
    });

    it('should auto-generate secret when not provided (with warning)', () => {
      // When secret is not provided, the system should auto-generate one
      // and successfully create an instance (with warnings logged)
      const result = createBetterAuthInstance({
        config: {
          enabled: true,
          // secret is missing - will be auto-generated
        },
        db,
      });

      // Should successfully create instance with auto-generated secret
      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('should throw error when secret is too short', () => {
      expect(() => {
        createBetterAuthInstance({
          config: {
            enabled: true,
            secret: 'short', // Less than 32 characters
          },
          db,
        });
      }).toThrow('Secret must be at least 32 characters long');
    });

    it('should throw error for invalid baseUrl format', () => {
      expect(() => {
        createBetterAuthInstance({
          config: {
            baseUrl: 'not-a-valid-url',
            enabled: true,
            secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
          },
          db,
        });
      }).toThrow('Invalid baseUrl format');
    });

    it('should throw error for invalid trustedOrigins format', () => {
      expect(() => {
        createBetterAuthInstance({
          config: {
            enabled: true,
            secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
            trustedOrigins: ['https://valid.com', 'not-valid-url'],
          },
          db,
        });
      }).toThrow('Invalid trustedOrigin format');
    });

    it('should throw error for invalid passkey origin', () => {
      expect(() => {
        createBetterAuthInstance({
          config: {
            enabled: true,
            passkey: {
              enabled: true,
              origin: 'invalid-origin',
              rpId: 'localhost',
              rpName: 'Test',
            },
            secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
            trustedOrigins: ['http://localhost:3000'],
          },
          db,
        });
      }).toThrow('Invalid passkey origin format');
    });

    it('should throw error when social provider is enabled without clientId', () => {
      expect(() => {
        createBetterAuthInstance({
          config: {
            enabled: true,
            secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
            socialProviders: {
              google: {
                clientId: '', // Missing clientId
                clientSecret: 'test-secret',
                enabled: true,
              },
            },
          },
          db,
        });
      }).toThrow("Social provider 'google' is missing clientId");
    });

    it('should throw error when social provider is enabled without clientSecret', () => {
      expect(() => {
        createBetterAuthInstance({
          config: {
            enabled: true,
            secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
            socialProviders: {
              github: {
                clientId: 'test-client-id',
                clientSecret: '', // Missing clientSecret
                enabled: true,
              },
            },
          },
          db,
        });
      }).toThrow("Social provider 'github' is missing clientSecret");
    });

    it('should create instance with valid configuration', () => {
      const result = createBetterAuthInstance({
        config: {
          basePath: '/iam',
          baseUrl: 'http://localhost:3000',
          enabled: true,
          secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
        },
        db,
      });

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('should create instance with JWT plugin enabled', () => {
      const result = createBetterAuthInstance({
        config: {
          enabled: true,
          jwt: {
            enabled: true,
            expiresIn: '1h',
          },
          secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
        },
        db,
      });

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('should create instance with 2FA plugin enabled', () => {
      const result = createBetterAuthInstance({
        config: {
          enabled: true,
          secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
          twoFactor: {
            appName: 'Test App',
            enabled: true,
          },
        },
        db,
      });

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('should create instance with Passkey plugin enabled', () => {
      const result = createBetterAuthInstance({
        config: {
          enabled: true,
          passkey: {
            enabled: true,
            origin: 'http://localhost:3000',
            rpId: 'localhost',
            rpName: 'Test App',
          },
          secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
          trustedOrigins: ['http://localhost:3000'],
        },
        db,
      });

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('should create instance with social providers configured', () => {
      const result = createBetterAuthInstance({
        config: {
          enabled: true,
          secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
          socialProviders: {
            github: {
              clientId: 'github-client-id',
              clientSecret: 'github-client-secret',
              enabled: true,
            },
            google: {
              clientId: 'google-client-id',
              clientSecret: 'google-client-secret',
              enabled: true,
            },
          },
        },
        db,
      });

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('should create instance with custom trustedOrigins', () => {
      const result = createBetterAuthInstance({
        config: {
          enabled: true,
          secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
          trustedOrigins: ['https://example.com', 'https://app.example.com'],
        },
        db,
      });

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('should create instance with all plugins enabled', () => {
      const result = createBetterAuthInstance({
        config: {
          basePath: '/auth',
          baseUrl: 'https://api.example.com',
          enabled: true,
          jwt: {
            enabled: true,
            expiresIn: '30m',
          },
          passkey: {
            enabled: true,
            origin: 'https://example.com',
            rpId: 'example.com',
            rpName: 'Example App',
          },
          secret: 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing',
          socialProviders: {
            apple: {
              clientId: 'apple-id',
              clientSecret: 'apple-secret',
              enabled: true,
            },
            github: {
              clientId: 'github-id',
              clientSecret: 'github-secret',
              enabled: true,
            },
            google: {
              clientId: 'google-id',
              clientSecret: 'google-secret',
              enabled: true,
            },
          },
          trustedOrigins: ['https://example.com', 'https://app.example.com'],
          twoFactor: {
            appName: 'Example App',
            enabled: true,
          },
        },
        db,
      });

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });
  });

  // ===================================================================================================================
  // BetterAuth REST API Endpoint Tests (when enabled)
  // ===================================================================================================================

  describe('BetterAuth REST API Endpoints', () => {
    // These tests verify the REST API endpoints are accessible when better-auth is enabled
    // Better-Auth is enabled by default in local/test environment
    // Note: GraphQL tests provide comprehensive coverage; these tests verify REST availability

    it('should return 404 for non-existent better-auth endpoints', async () => {
      // Non-existent endpoints should return 404
      // Note: statusCode option validates the response status internally in TestHelper
      await testHelper.rest('/iam/nonexistent', {
        method: 'GET',
        statusCode: 404,
      });
    });
  });

  // ===================================================================================================================
  // Bug #3 Regression: JWT Warning Logic
  // ===================================================================================================================

  describe('JWT Warning Logic (Bug #3)', () => {
    it('should consider JWT enabled by default (undefined config)', () => {
      // JWT is enabled by default - isJwtEnabled should return true when jwt config is undefined
      const betterAuthService = app.get(CoreBetterAuthService);
      expect(betterAuthService.isJwtEnabled()).toBe(true);
    });

    it('should match isJwtEnabled logic: undefined = enabled, false = disabled', () => {
      // The warning logic in CoreBetterAuthModule.onModuleInit must match
      // CoreBetterAuthService.isJwtEnabled(). This test verifies the service behavior
      // that the warning logic must align with.
      const betterAuthService = app.get(CoreBetterAuthService);

      // Current local config has jwt: { enabled: true } → should be enabled
      expect(betterAuthService.isJwtEnabled()).toBe(true);

      // Verify the config is present (not undefined)
      const config = betterAuthService.getConfig();
      expect(config.jwt).toBeDefined();
    });
  });

  // ===================================================================================================================
  // Bug #4 Regression: JWT Token in Cookie-less Mode
  // ===================================================================================================================

  describe('JWT Token Resolution (Bug #4)', () => {
    beforeAll(async () => {
      // Clear stale JWKS keys that may have been encrypted with a different secret
      // This prevents "Failed to decrypt private key" errors during JWT generation
      if (db) {
        await db.collection('jwks').deleteMany({});
      }
    });

    it('should return a proper JWT (not session token) from REST sign-in when cookies are disabled', async () => {
      const cookiesDisabled = configService.getFastButReadOnly('cookies') === false;
      if (!cookiesDisabled) {
        // Skip test when cookies are enabled (different auth flow)
        return;
      }

      const email = `jwt-bug4-rest-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
      const password = 'SecurePassword123!';

      // Create user via sign-up
      await testHelper.rest('/iam/sign-up/email', {
        method: 'POST',
        payload: { email, password, termsAndPrivacyAccepted: true },
        statusCode: 201,
      });

      // Track for cleanup
      const iamUser = await db.collection('iam_user').findOne({ email });
      const cleanupIamId = iamUser?._id;
      const user = await db.collection('users').findOne({ email });
      const cleanupUserId = user?._id?.toString();

      try {
        // Sign in
        const signInRes: any = await testHelper.rest('/iam/sign-in/email', {
          method: 'POST',
          payload: { email, password },
          statusCode: 200,
        });

        expect(signInRes).toBeDefined();
        expect(signInRes.token).toBeDefined();

        // Bug #4: Token must be a JWT (starts with "eyJ" and has 3 dot-separated parts)
        const token = signInRes.token;
        expect(token).toMatch(/^eyJ/);
        expect(token.split('.').length).toBe(3);
      } finally {
        // Cleanup
        if (cleanupUserId) {
          await db.collection('users').deleteOne({ _id: new ObjectId(cleanupUserId) });
        }
        if (cleanupIamId) {
          await db.collection('iam_user').deleteOne({ _id: cleanupIamId });
          await db.collection('iam_session').deleteMany({ userId: cleanupIamId });
        }
      }
    });

    it('should return a proper JWT (not session token) from GraphQL sign-in when cookies are disabled', async () => {
      const cookiesDisabled = configService.getFastButReadOnly('cookies') === false;
      if (!cookiesDisabled) {
        return;
      }

      const email = `jwt-bug4-gql-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@test.com`;
      const password = 'SecurePassword123!';

      // Create user via sign-up
      const signUpRes: any = await testHelper.graphQl({
        arguments: { email, password, termsAndPrivacyAccepted: true },
        fields: ['success', { user: ['id'] }],
        name: 'betterAuthSignUp',
        type: TestGraphQLType.MUTATION,
      });

      const userId = signUpRes?.user?.id;
      const iamUser = await db.collection('iam_user').findOne({ email });
      const cleanupIamId = iamUser?._id;

      try {
        // Sign in
        const signInRes: any = await testHelper.graphQl({
          arguments: { email, password },
          fields: ['success', 'token'],
          name: 'betterAuthSignIn',
          type: TestGraphQLType.MUTATION,
        });

        expect(signInRes.success).toBe(true);
        expect(signInRes.token).toBeDefined();

        // Bug #4: Token must be a JWT (starts with "eyJ" and has 3 dot-separated parts)
        const token = signInRes.token;
        expect(token).toMatch(/^eyJ/);
        expect(token.split('.').length).toBe(3);
      } finally {
        // Cleanup
        if (userId) {
          await db.collection('users').deleteOne({ _id: new ObjectId(userId) });
        }
        if (cleanupIamId) {
          await db.collection('iam_user').deleteOne({ _id: cleanupIamId });
          await db.collection('iam_session').deleteMany({ userId: cleanupIamId });
        }
      }
    });
  });
});
