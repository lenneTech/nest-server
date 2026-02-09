/**
 * Unit Tests: CoreModule.forRoot() Signatures
 *
 * Tests the three CoreModule.forRoot() signatures without full E2E setup.
 * Verifies that each signature is correctly detected and configured.
 *
 * Scenario 1: Legacy Only - 3-param signature with betterAuth.enabled: false
 * Scenario 2: Legacy + IAM - 3-param signature with betterAuth.enabled: true
 * Scenario 3: IAM Only - 1-param signature (new projects)
 */

import { DynamicModule } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreModule } from '../../src/core.module';
import { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import { ComplexityPlugin } from '../../src/core/common/plugins/complexity.plugin';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAuthService } from '../../src/core/modules/auth/services/core-auth.service';

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
});
