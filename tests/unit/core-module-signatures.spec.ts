/**
 * Unit Tests: CoreModule.forRoot() Signatures
 *
 * Tests the CoreModule.forRoot() signatures without full E2E setup.
 * Verifies that each signature is correctly detected and configured.
 *
 * Scenario 1: Legacy Only - 3-param signature with betterAuth.enabled: false
 * Scenario 2: Legacy + IAM - 3-param signature with betterAuth.enabled: true
 * Scenario 3: IAM Only - 1-param signature (new projects)
 * Scenario 4: ICoreModuleOverrides - overrides parameter for both signatures
 */

import { DynamicModule, Injectable } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreModule } from '../../src/core.module';
import { ICoreModuleOverrides, IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import { ComplexityPlugin } from '../../src/core/common/plugins/complexity.plugin';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';
import { CoreBetterAuthModule } from '../../src/core/modules/better-auth/core-better-auth.module';
import { ErrorCodeModule } from '../../src/core/modules/error-code/error-code.module';

// Mock AuthModule for testing
const MockAuthModule = {
  forRoot: vi.fn().mockReturnValue({
    exports: [],
    module: class MockAuthModuleClass {},
    providers: [],
  }),
};

// Base test configuration
const baseConfig: Partial<IServerOptions> = {
  env: 'test',
  jwt: {
    refresh: {
      secret: 'test-refresh-secret',
    },
    secret: 'test-secret',
  },
  mongoose: {
    uri: 'mongodb://localhost/test',
  },
};

describe('CoreModule.forRoot() Signatures', () => {
  // Suppress console.warn during tests (JWT secret warning)
  const originalWarn = console.warn;

  beforeEach(() => {
    console.warn = vi.fn();
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  // ===========================================================================================================
  // Signature Detection Tests
  // ===========================================================================================================

  describe('Signature Detection', () => {
    it('should detect 1-parameter signature (IAM Only mode)', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: {
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
      };

      const result: DynamicModule = CoreModule.forRoot(config);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);

      // In IAM-only mode, the GraphQL driver should import BetterAuthModule
      // The driver is configured internally, we verify the module returns correctly
      expect(result.imports).toBeDefined();
    });

    it('should detect 3-parameter signature (Legacy mode)', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: {
          enabled: false,
        },
      };

      const result: DynamicModule = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
      expect(result.imports).toBeDefined();
    });

    it('should detect 3-parameter signature (Legacy + IAM mode)', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: {
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
      };

      const result: DynamicModule = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
    });
  });

  // ===========================================================================================================
  // Scenario 1: Legacy Only
  // ===========================================================================================================

  describe('Scenario 1: Legacy Only (3-param, betterAuth disabled)', () => {
    it('should accept CoreAuthService as first parameter', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: { enabled: false },
      };

      const result = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config);

      expect(result.module).toBe(CoreModule);
    });

    it('should work with betterAuth.enabled explicitly set to false', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: { enabled: false },
      };

      const result = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config);

      expect(result).toBeDefined();
      // Module should still be created successfully
      expect(result.providers).toBeDefined();
      expect(result.exports).toBeDefined();
    });

    it('should work when betterAuth is not configured at all', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        // No betterAuth config - defaults to disabled behavior
      };

      const result = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
    });
  });

  // ===========================================================================================================
  // Scenario 2: Legacy + IAM (Migration)
  // ===========================================================================================================

  describe('Scenario 2: Legacy + IAM (3-param, betterAuth enabled)', () => {
    it('should accept 3 parameters with betterAuth enabled', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: {
          basePath: '/iam',
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
      };

      const result = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
    });

    it('should include ConfigService provider with merged config', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: {
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
      };

      const result = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config);

      // Check that providers are defined
      expect(result.providers).toBeDefined();
      expect(Array.isArray(result.providers)).toBe(true);

      // ConfigService should be provided (either as class or value)
      expect(result.providers?.length).toBeGreaterThan(0);
    });

    it('should support legacy endpoints configuration', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        auth: {
          legacyEndpoints: {
            enabled: true, // Keep legacy endpoints during migration
          },
        },
        betterAuth: {
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
      };

      const result = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config);

      expect(result).toBeDefined();
    });
  });

  // ===========================================================================================================
  // Scenario 3: IAM Only
  // ===========================================================================================================

  describe('Scenario 3: IAM Only (1-param signature)', () => {
    it('should accept single config parameter', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: {
          basePath: '/iam',
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
      };

      const result = CoreModule.forRoot(config);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
    });

    it('should work without AuthService and AuthModule', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        auth: {
          legacyEndpoints: {
            enabled: false, // Disable legacy endpoints for IAM-only
          },
        },
        betterAuth: {
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
      };

      // This is the key test - only 1 parameter, no AuthService/AuthModule
      const result = CoreModule.forRoot(config);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
      expect(result.imports).toBeDefined();
    });

    it('should configure GraphQL driver for BetterAuth sessions', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: {
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
        graphQl: {
          enableSubscriptionAuth: true,
        },
      };

      const result = CoreModule.forRoot(config);

      expect(result).toBeDefined();
      // GraphQL driver is configured internally in buildIamOnlyGraphQlDriver
      // We verify the module structure is correct
      expect(result.imports).toBeDefined();
    });

    it('should support disabling legacy endpoints', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        auth: {
          legacyEndpoints: {
            enabled: false,
            graphql: false,
            rest: false,
          },
        },
        betterAuth: {
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
      };

      const result = CoreModule.forRoot(config);

      expect(result).toBeDefined();
    });
  });

  // ===========================================================================================================
  // Configuration Merging Tests
  // ===========================================================================================================

  describe('Configuration Merging', () => {
    it('should merge default config with provided options', () => {
      const customPort = 4000;
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        port: customPort,
      };

      const result = CoreModule.forRoot(config);

      expect(result).toBeDefined();
      // The port should be used in the merged config
      // (verified indirectly through successful module creation)
    });

    it('should apply CORS settings when cookies are enabled', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: {
          enabled: true,
          secret: 'betterauth-secret-32-chars-min!!',
        },
        cookies: true,
      };

      const result = CoreModule.forRoot(config);

      expect(result).toBeDefined();
      // CORS is configured internally, we verify module creation succeeds
    });

    it('should handle missing optional configuration gracefully', () => {
      const minimalConfig: Partial<IServerOptions> = {
        mongoose: {
          uri: 'mongodb://localhost/minimal-test',
        },
      };

      // This should not throw
      const result = CoreModule.forRoot(minimalConfig);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
    });
  });

  // ===========================================================================================================
  // Edge Cases
  // ===========================================================================================================

  describe('Edge Cases', () => {
    it('should handle empty config object', () => {
      const result = CoreModule.forRoot({});

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
    });

    it('should distinguish between 1-param and 3-param signatures correctly', () => {
      // 1-param: Only config object
      const iamOnlyResult = CoreModule.forRoot({ ...baseConfig });

      // 3-param: AuthService, AuthModule, config
      const legacyResult = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), { ...baseConfig });

      // Both should return valid DynamicModule
      expect(iamOnlyResult.module).toBe(CoreModule);
      expect(legacyResult.module).toBe(CoreModule);

      // They should have different internal configurations
      // (the GraphQL driver factory differs between modes)
      expect(iamOnlyResult).not.toEqual(legacyResult);
    });

    it('should apply security interceptor configuration', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        security: {
          checkResponseInterceptor: true,
          checkSecurityInterceptor: true,
        },
      };

      const result = CoreModule.forRoot(config);

      expect(result).toBeDefined();
      expect(result.providers).toBeDefined();
    });
  });

  // ===========================================================================================================
  // GraphQL Disabled Tests (graphQl: false)
  // ===========================================================================================================

  describe('GraphQL Disabled (graphQl: false)', () => {
    it('should accept graphQl: false in 1-param signature', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        graphQl: false,
      };

      const result: DynamicModule = CoreModule.forRoot(config);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
    });

    it('should not include GraphQLModule in imports when graphQl: false', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        graphQl: false,
      };

      const result: DynamicModule = CoreModule.forRoot(config);

      // GraphQLModule should not be in imports
      const importNames = (result.imports || []).map((imp: any) => {
        if (typeof imp === 'function') return imp.name;
        if (imp?.module) return typeof imp.module === 'function' ? imp.module.name : String(imp.module);
        return String(imp);
      });
      expect(importNames).not.toContain('GraphQLModule');
    });

    it('should not include ComplexityPlugin in providers when graphQl: false', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        graphQl: false,
      };

      const result: DynamicModule = CoreModule.forRoot(config);

      // ComplexityPlugin should not be in providers
      const hasComplexityPlugin = (result.providers || []).some(
        (p: any) => p === ComplexityPlugin || p?.useClass === ComplexityPlugin,
      );
      expect(hasComplexityPlugin).toBe(false);
    });

    it('should not include ComplexityPlugin in exports when graphQl: false', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        graphQl: false,
      };

      const result: DynamicModule = CoreModule.forRoot(config);

      expect(result.exports).not.toContain(ComplexityPlugin);
    });

    it('should accept graphQl: false in 3-param signature', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        betterAuth: { enabled: false },
        graphQl: false,
      };

      const result: DynamicModule = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config);

      expect(result).toBeDefined();
      expect(result.module).toBe(CoreModule);
    });

    it('should still include MongooseModule when graphQl: false', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        graphQl: false,
      };

      const result: DynamicModule = CoreModule.forRoot(config);

      // MongooseModule should still be in imports
      const importNames = (result.imports || []).map((imp: any) => {
        if (typeof imp === 'function') return imp.name;
        if (imp?.module) return typeof imp.module === 'function' ? imp.module.name : String(imp.module);
        return String(imp);
      });
      expect(importNames).toContain('MongooseModule');
    });

    it('should still include ConfigService when graphQl: false', () => {
      const config: Partial<IServerOptions> = {
        ...baseConfig,
        graphQl: false,
      };

      const result: DynamicModule = CoreModule.forRoot(config);

      expect(result.exports).toContain(ConfigService);
    });
  });

  // ===========================================================================================================
  // Type Safety Tests
  // ===========================================================================================================

  describe('Type Safety', () => {
    it('should accept IServerOptions for 1-param signature', () => {
      const config: Partial<IServerOptions> = {
        env: 'production',
        mongoose: { uri: 'mongodb://localhost/test' },
        port: 3000,
      };

      // TypeScript should accept this without errors
      const result: DynamicModule = CoreModule.forRoot(config);

      expect(result).toBeDefined();
    });

    it('should accept proper types for 3-param signature', () => {
      const config: Partial<IServerOptions> = {
        env: 'production',
        mongoose: { uri: 'mongodb://localhost/test' },
      };

      // TypeScript should accept these types
      const result: DynamicModule = CoreModule.forRoot(
        CoreAuthService, // Type: any (AuthService class)
        MockAuthModule.forRoot(), // Type: any (AuthModule)
        config, // Type: Partial<IServerOptions>
      );

      expect(result).toBeDefined();
    });
  });

  // ===========================================================================================================
  // Scenario 4: ICoreModuleOverrides
  // ===========================================================================================================

  describe('Scenario 4: ICoreModuleOverrides', () => {
    // Mock classes for override testing
    @Injectable()
    class MockErrorCodeController {}

    @Injectable()
    class MockErrorCodeService {}

    @Injectable()
    class MockBetterAuthController {}

    @Injectable()
    class MockBetterAuthResolver {}

    // Helper to find an ErrorCodeModule DynamicModule in the imports array
    function findErrorCodeImport(result: DynamicModule): DynamicModule | undefined {
      return (result.imports || []).find(
        (imp: any) => imp?.module === ErrorCodeModule,
      ) as DynamicModule | undefined;
    }

    describe('IAM-only mode with overrides (2-param signature)', () => {
      it('should accept overrides as second parameter', () => {
        const config: Partial<IServerOptions> = { ...baseConfig };
        const overrides: ICoreModuleOverrides = {
          errorCode: { controller: MockErrorCodeController },
        };

        const result = CoreModule.forRoot(config, overrides);

        expect(result).toBeDefined();
        expect(result.module).toBe(CoreModule);
      });

      it('should pass errorCode overrides to ErrorCodeModule.forRoot()', () => {
        const config: Partial<IServerOptions> = { ...baseConfig };
        const overrides: ICoreModuleOverrides = {
          errorCode: {
            controller: MockErrorCodeController,
            service: MockErrorCodeService,
          },
        };

        const result = CoreModule.forRoot(config, overrides);
        const errorCodeImport = findErrorCodeImport(result);

        expect(errorCodeImport).toBeDefined();
        // The custom controller should be registered
        expect(errorCodeImport?.controllers).toContain(MockErrorCodeController);
      });

      it('should correctly detect IAM-only mode when overrides are passed', () => {
        const config: Partial<IServerOptions> = {
          ...baseConfig,
          betterAuth: {
            enabled: true,
            secret: 'betterauth-secret-32-chars-min!!',
          },
        };

        // With the old detection (authModuleOrUndefined === undefined),
        // this would have been misdetected as Legacy mode because overrides
        // as 2nd arg would make authModuleOrUndefined !== undefined
        const result = CoreModule.forRoot(config, {
          errorCode: { controller: MockErrorCodeController },
        });

        expect(result).toBeDefined();
        expect(result.module).toBe(CoreModule);

        // Verify IAM-only mode: Legacy Auth module should NOT be in imports
        const importModuleNames = (result.imports || []).map((imp: any) =>
          typeof imp === 'function' ? imp.name : imp?.module?.name || '',
        );
        expect(importModuleNames).not.toContain('MockAuthModuleClass');
      });
    });

    describe('Legacy mode with overrides (4-param signature)', () => {
      it('should accept overrides as fourth parameter', () => {
        const config: Partial<IServerOptions> = {
          ...baseConfig,
          betterAuth: { enabled: false },
        };
        const overrides: ICoreModuleOverrides = {
          errorCode: { controller: MockErrorCodeController },
        };

        const result = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config, overrides);

        expect(result).toBeDefined();
        expect(result.module).toBe(CoreModule);
      });

      it('should pass errorCode overrides in Legacy mode', () => {
        const config: Partial<IServerOptions> = {
          ...baseConfig,
          betterAuth: { enabled: false },
        };
        const overrides: ICoreModuleOverrides = {
          errorCode: {
            controller: MockErrorCodeController,
            service: MockErrorCodeService,
          },
        };

        const result = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), config, overrides);
        const errorCodeImport = findErrorCodeImport(result);

        expect(errorCodeImport).toBeDefined();
        expect(errorCodeImport?.controllers).toContain(MockErrorCodeController);
      });
    });

    describe('Override precedence', () => {
      it('should use overrides.betterAuth.controller over config.betterAuth.controller', () => {
        // Spy on CoreBetterAuthModule.forRoot to capture the options it receives
        const originalForRoot = CoreBetterAuthModule.forRoot.bind(CoreBetterAuthModule);
        let capturedOptions: any = null;
        vi.spyOn(CoreBetterAuthModule, 'forRoot').mockImplementation((options: any) => {
          capturedOptions = options;
          return originalForRoot(options);
        });

        try {
          const config: Partial<IServerOptions> = {
            ...baseConfig,
            betterAuth: {
              controller: MockErrorCodeController, // wrong class intentionally
              enabled: true,
              secret: 'betterauth-secret-32-chars-min!!',
            },
          };
          const overrides: ICoreModuleOverrides = {
            betterAuth: { controller: MockBetterAuthController },
          };

          CoreModule.forRoot(config, overrides);

          // The override controller should have been passed, not the config one
          expect(capturedOptions).not.toBeNull();
          expect(capturedOptions.controller).toBe(MockBetterAuthController);
          expect(capturedOptions.controller).not.toBe(MockErrorCodeController);
        } finally {
          vi.restoreAllMocks();
        }
      });

      it('should forward overrides.betterAuth.resolver to CoreBetterAuthModule.forRoot()', () => {
        const originalForRoot = CoreBetterAuthModule.forRoot.bind(CoreBetterAuthModule);
        let capturedOptions: any = null;
        vi.spyOn(CoreBetterAuthModule, 'forRoot').mockImplementation((options: any) => {
          capturedOptions = options;
          return originalForRoot(options);
        });

        try {
          const config: Partial<IServerOptions> = {
            ...baseConfig,
            betterAuth: {
              enabled: true,
              secret: 'betterauth-secret-32-chars-min!!',
            },
          };
          const overrides: ICoreModuleOverrides = {
            betterAuth: { resolver: MockBetterAuthResolver },
          };

          CoreModule.forRoot(config, overrides);

          expect(capturedOptions).not.toBeNull();
          expect(capturedOptions.resolver).toBe(MockBetterAuthResolver);
        } finally {
          vi.restoreAllMocks();
        }
      });
    });

    describe('autoRegister: false + overrides warnings', () => {
      it('should warn when errorCode overrides are provided with autoRegister: false', () => {
        const warnSpy = vi.spyOn(console, 'warn');
        const config: Partial<IServerOptions> = {
          ...baseConfig,
          errorCode: { autoRegister: false },
        };
        const overrides: ICoreModuleOverrides = {
          errorCode: { controller: MockErrorCodeController },
        };

        CoreModule.forRoot(config, overrides);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('errorCode overrides are ignored'),
        );
      });

      it('should warn when betterAuth overrides are provided with autoRegister: false', () => {
        const warnSpy = vi.spyOn(console, 'warn');
        const config: Partial<IServerOptions> = {
          ...baseConfig,
          betterAuth: {
            autoRegister: false,
            enabled: true,
            secret: 'betterauth-secret-32-chars-min!!',
          },
        };
        const overrides: ICoreModuleOverrides = {
          betterAuth: { resolver: MockBetterAuthResolver },
        };

        CoreModule.forRoot(config, overrides);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('betterAuth overrides are ignored'),
        );
      });

      it('should NOT warn when overrides are provided without autoRegister: false', () => {
        const warnSpy = vi.spyOn(console, 'warn');
        const config: Partial<IServerOptions> = { ...baseConfig };
        const overrides: ICoreModuleOverrides = {
          errorCode: { controller: MockErrorCodeController },
        };

        CoreModule.forRoot(config, overrides);

        // Should not contain errorCode warning (other warnings like JWT are OK)
        const errorCodeWarns = (warnSpy as any).mock.calls.filter(
          (call: any[]) => typeof call[0] === 'string' && call[0].includes('errorCode overrides are ignored'),
        );
        expect(errorCodeWarns).toHaveLength(0);
      });
    });

    describe('No overrides (backward compatibility)', () => {
      it('should use default CoreErrorCodeController when no overrides provided', () => {
        const result = CoreModule.forRoot({ ...baseConfig });
        const errorCodeImport = findErrorCodeImport(result);

        expect(errorCodeImport).toBeDefined();
        // Default controller should be registered, not a custom one
        expect(errorCodeImport?.controllers).toBeDefined();
        expect(errorCodeImport?.controllers).toHaveLength(1);
        expect(errorCodeImport?.controllers?.[0]).not.toBe(MockErrorCodeController);
      });

      it('should work without overrides in Legacy mode', () => {
        const result = CoreModule.forRoot(CoreAuthService, MockAuthModule.forRoot(), {
          ...baseConfig,
          betterAuth: { enabled: false },
        });
        const errorCodeImport = findErrorCodeImport(result);

        expect(result.module).toBe(CoreModule);
        expect(errorCodeImport).toBeDefined();
        expect(errorCodeImport?.controllers).toBeDefined();
        expect(errorCodeImport?.controllers).toHaveLength(1);
        expect(errorCodeImport?.controllers?.[0]).not.toBe(MockErrorCodeController);
      });
    });
  });
});
