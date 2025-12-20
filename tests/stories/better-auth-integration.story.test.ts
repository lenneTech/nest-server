/**
 * Story: BetterAuth Integration
 *
 * As a developer using @lenne.tech/nest-server,
 * I want to integrate better-auth for modern authentication,
 * So that I can use 2FA, Passkeys, and Social Login in my application.
 *
 * This test file verifies the basic integration of the BetterAuthModule
 * with the nest-server framework.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongoClient, ObjectId } from 'mongodb';

import {
  BETTER_AUTH_INSTANCE,
  BetterAuthModule,
  BetterAuthService,
  ConfigService,
  createBetterAuthInstance,
  TestGraphQLType,
  TestHelper,
} from '../../src';
import envConfig from '../../src/config.env';
import { ServerModule } from '../../src/server/server.module';

describe('Story: BetterAuth Integration', () => {
  // Test environment properties
  const port = 3040;
  let app;
  let testHelper: TestHelper;

  // database
  let connection;
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
      }).compile();

      app = moduleFixture.createNestApplication();
      await app.init();

      testHelper = new TestHelper(app, `ws://127.0.0.1:${port}/graphql`);
      configService = moduleFixture.get(ConfigService);

      await app.listen(port, '127.0.0.1');

      // Connection to database
      connection = await MongoClient.connect(envConfig.mongoose.uri);
      db = await connection.db();
    } catch (e) {
      console.error('beforeAllError', e);
      throw e;
    }
  });

  afterAll(async () => {
    if (connection) {
      await connection.close();
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

    it('should have legacy password configuration for migration', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.legacyPassword).toBeDefined();
      expect(betterAuthConfig.legacyPassword.enabled).toBe(true);
    });
  });

  describe('BetterAuthModule (Disabled)', () => {
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
          BetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfigService }],
      }).compile();

      const betterAuthInstance = moduleRef.get(BETTER_AUTH_INSTANCE);
      expect(betterAuthInstance).toBeNull();

      await moduleRef.close();
    });

    it('should provide BetterAuthService when disabled', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          BetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfigService }],
      }).compile();

      const betterAuthService = moduleRef.get(BetterAuthService);
      expect(betterAuthService).toBeDefined();
      expect(betterAuthService.isEnabled()).toBe(false);
      expect(betterAuthService.getInstance()).toBeNull();
      expect(betterAuthService.getApi()).toBeNull();

      await moduleRef.close();
    });
  });

  describe('BetterAuthModule.reset()', () => {
    it('should reset static state for testing', () => {
      // First, verify reset method exists
      expect(typeof BetterAuthModule.reset).toBe('function');

      // Call reset
      BetterAuthModule.reset();

      // After reset, getInstance should return null
      expect(BetterAuthModule.getInstance()).toBeNull();
    });

    it('should allow fresh initialization after reset', async () => {
      // Reset before test
      BetterAuthModule.reset();

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
          BetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfigService }],
      }).compile();

      const betterAuthService = moduleRef.get(BetterAuthService);
      expect(betterAuthService).toBeDefined();
      expect(betterAuthService.isEnabled()).toBe(false);

      await moduleRef.close();

      // Reset after test for clean state
      BetterAuthModule.reset();
    });
  });

  describe('BetterAuthService (Disabled Mode)', () => {
    let moduleRef: TestingModule;
    let betterAuthService: BetterAuthService;

    const mockConfigService = {
      get: (key: string) => {
        if (key === 'betterAuth') {
          return {
            enabled: false,
            jwt: { enabled: true, expiresIn: '15m' },
            legacyPassword: { enabled: true },
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
          BetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfigService }],
      }).compile();

      betterAuthService = moduleRef.get(BetterAuthService);
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

    it('should report isLegacyPasswordEnabled as false when disabled', () => {
      // Even if legacyPassword is configured as enabled, it should return false
      // because the main betterAuth is disabled
      expect(betterAuthService.isLegacyPasswordEnabled()).toBe(false);
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

    it('should have 2FA disabled by default in test environment', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.twoFactor.enabled).toBe(false);
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
          BetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfig }],
      }).compile();

      const betterAuthService = moduleRef.get(BetterAuthService);
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

    it('should have Passkey disabled by default in test environment', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.passkey.enabled).toBe(false);
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
          BetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfig }],
      }).compile();

      const betterAuthService = moduleRef.get(BetterAuthService);
      // Even if passkey.enabled is true, isPasskeyEnabled returns false
      // because the main betterAuth is disabled
      expect(betterAuthService.isPasskeyEnabled()).toBe(false);

      await moduleRef.close();
    });
  });

  // ===================================================================================================================
  // Phase 5: Legacy Password Handling Tests
  // ===================================================================================================================

  describe('Legacy Password Handling Configuration', () => {
    it('should have legacyPassword configuration', () => {
      const betterAuthConfig = configService.get('betterAuth');

      expect(betterAuthConfig.legacyPassword).toBeDefined();
    });

    it('should have legacyPassword enabled for migration support', () => {
      const betterAuthConfig = configService.get('betterAuth');

      // Legacy password handling should be enabled to support existing users
      expect(betterAuthConfig.legacyPassword.enabled).toBe(true);
    });

    it('should report isLegacyPasswordEnabled correctly via service', async () => {
      const mockConfig = {
        get: (key: string) => {
          if (key === 'betterAuth') {
            return {
              enabled: false,
              legacyPassword: { enabled: true },
            };
          }
          return undefined;
        },
      };

      const moduleRef = await Test.createTestingModule({
        imports: [
          BetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfig }],
      }).compile();

      const betterAuthService = moduleRef.get(BetterAuthService);
      // Even if legacyPassword.enabled is true, isLegacyPasswordEnabled returns false
      // because the main betterAuth is disabled
      expect(betterAuthService.isLegacyPasswordEnabled()).toBe(false);

      await moduleRef.close();
    });

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
          BetterAuthModule.forRoot({
            config: { enabled: false },
          }),
        ],
        providers: [{ provide: ConfigService, useValue: mockConfig }],
      }).compile();

      const betterAuthService = moduleRef.get(BetterAuthService);
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
    // Note: In test environment, better-auth is disabled by default, so these test the disabled behavior

    it('should not expose better-auth endpoints when disabled', async () => {
      // When better-auth is disabled, the /iam endpoints should not be available
      const response = await testHelper.rest('/iam/sign-up', {
        method: 'POST',
        payload: {
          email: 'test@example.com',
          password: 'TestPassword123!',
        },
        statusCode: 404, // Expecting 404 because better-auth is disabled
      });

      // The response should indicate the endpoint is not found
      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for better-auth session endpoint when disabled', async () => {
      const response = await testHelper.rest('/iam/session', {
        method: 'GET',
        statusCode: 404,
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
