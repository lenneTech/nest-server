/**
 * Unit tests for:
 * 1. Deep-merge logic in createBetterAuthInstance (advanced options)
 * 2. resolveCrossSubDomainCookies Boolean Shorthand resolution
 *
 * The merge logic being tested (from better-auth.config.ts):
 *   if (config.options) {
 *     const { advanced: optionsAdvanced, ...restOptions } = config.options;
 *     finalConfig = { ...betterAuthConfig, ...restOptions };
 *     if (optionsAdvanced && typeof optionsAdvanced === 'object') {
 *       finalConfig.advanced = {
 *         ...(betterAuthConfig.advanced),
 *         ...(optionsAdvanced),
 *       };
 *     }
 *   }
 */
import { describe, expect, it } from 'vitest';

import { resolveCrossSubDomainCookies } from '../../src/core/modules/better-auth/better-auth.config';

/**
 * Standalone implementation of the deep-merge logic for isolated testing.
 * Mirrors the exact logic from createBetterAuthInstance in better-auth.config.ts.
 */
function mergeConfigWithOptions(
  betterAuthConfig: Record<string, unknown>,
  options?: Record<string, unknown>,
): Record<string, unknown> {
  if (options) {
    const { advanced: optionsAdvanced, ...restOptions } = options;
    const finalConfig = { ...betterAuthConfig, ...restOptions };
    if (optionsAdvanced && typeof optionsAdvanced === 'object') {
      finalConfig.advanced = {
        ...(betterAuthConfig.advanced as Record<string, unknown>),
        ...(optionsAdvanced as Record<string, unknown>),
      };
    }
    return finalConfig;
  }
  return betterAuthConfig;
}

describe('BetterAuth Config Deep-Merge', () => {
  const baseConfig = {
    advanced: {
      cookiePrefix: 'iam',
    },
    basePath: '/iam',
    baseURL: 'http://localhost:3000',
  };

  describe('without options', () => {
    it('should return the base config unchanged', () => {
      const result = mergeConfigWithOptions(baseConfig);

      expect(result).toBe(baseConfig); // Same reference
      expect(result.advanced).toEqual({ cookiePrefix: 'iam' });
    });
  });

  describe('with options but no advanced', () => {
    it('should shallow-merge non-advanced options', () => {
      const result = mergeConfigWithOptions(baseConfig, {
        secret: 'my-secret',
      });

      expect(result.secret).toBe('my-secret');
      expect(result.advanced).toEqual({ cookiePrefix: 'iam' });
      expect(result.basePath).toBe('/iam');
    });

    it('should allow overriding top-level properties', () => {
      const result = mergeConfigWithOptions(baseConfig, {
        baseURL: 'https://api.example.com',
      });

      expect(result.baseURL).toBe('https://api.example.com');
      expect(result.advanced).toEqual({ cookiePrefix: 'iam' });
    });
  });

  describe('with options.advanced (deep-merge)', () => {
    it('should preserve cookiePrefix when adding crossSubDomainCookies', () => {
      const result = mergeConfigWithOptions(baseConfig, {
        advanced: {
          crossSubDomainCookies: {
            domain: 'example.com',
          },
        },
      });

      const advanced = result.advanced as Record<string, unknown>;
      expect(advanced.cookiePrefix).toBe('iam');
      expect(advanced.crossSubDomainCookies).toEqual({ domain: 'example.com' });
    });

    it('should preserve cookiePrefix when adding other advanced options', () => {
      const result = mergeConfigWithOptions(baseConfig, {
        advanced: {
          useSecureCookies: true,
        },
      });

      const advanced = result.advanced as Record<string, unknown>;
      expect(advanced.cookiePrefix).toBe('iam');
      expect(advanced.useSecureCookies).toBe(true);
    });

    it('should allow overriding cookiePrefix via advanced options', () => {
      const result = mergeConfigWithOptions(baseConfig, {
        advanced: {
          cookiePrefix: 'custom',
        },
      });

      const advanced = result.advanced as Record<string, unknown>;
      expect(advanced.cookiePrefix).toBe('custom');
    });

    it('should merge both advanced and non-advanced options', () => {
      const result = mergeConfigWithOptions(baseConfig, {
        advanced: {
          crossSubDomainCookies: {
            domain: 'example.com',
          },
        },
        secret: 'my-secret',
      });

      expect(result.secret).toBe('my-secret');
      const advanced = result.advanced as Record<string, unknown>;
      expect(advanced.cookiePrefix).toBe('iam');
      expect(advanced.crossSubDomainCookies).toEqual({ domain: 'example.com' });
    });
  });

  describe('edge cases', () => {
    it('should handle empty advanced object', () => {
      const result = mergeConfigWithOptions(baseConfig, {
        advanced: {},
      });

      const advanced = result.advanced as Record<string, unknown>;
      expect(advanced.cookiePrefix).toBe('iam');
    });

    it('should handle null advanced (not an object)', () => {
      const result = mergeConfigWithOptions(baseConfig, {
        advanced: null as unknown,
      });

      // null is not typeof 'object' in the check (actually it is in JS, but the code checks for truthy first)
      // The condition is: if (optionsAdvanced && typeof optionsAdvanced === 'object')
      // null is falsy, so the deep-merge is skipped
      expect(result.advanced).toEqual({ cookiePrefix: 'iam' });
    });

    it('should handle advanced as non-object (string)', () => {
      const result = mergeConfigWithOptions(baseConfig, {
        advanced: 'invalid' as unknown,
      });

      // String is truthy but typeof is 'string', not 'object'
      // Deep-merge is skipped, base advanced preserved
      expect(result.advanced).toEqual({ cookiePrefix: 'iam' });
    });

    it('should not mutate the original base config', () => {
      const originalAdvanced = { ...baseConfig.advanced };
      mergeConfigWithOptions(baseConfig, {
        advanced: {
          crossSubDomainCookies: { domain: 'example.com' },
        },
      });

      // Original should be unchanged
      expect(baseConfig.advanced).toEqual(originalAdvanced);
    });
  });

  describe('regression: shallow merge would break cookiePrefix', () => {
    it('should NOT lose cookiePrefix with the old shallow-merge approach', () => {
      // This test documents the bug that the deep-merge fix addresses.
      // Old code: finalConfig = { ...betterAuthConfig, ...config.options }
      // This would replace the entire 'advanced' object, losing cookiePrefix.

      // Simulate OLD behavior (shallow merge)
      const oldResult = ({
	...baseConfig,
	advanced: { crossSubDomainCookies: { domain: 'example.com' } }
});

      // OLD: cookiePrefix is LOST
      expect((oldResult.advanced as Record<string, unknown>).cookiePrefix).toBeUndefined();

      // NEW: cookiePrefix is PRESERVED
      const newResult = mergeConfigWithOptions(baseConfig, {
        advanced: {
          crossSubDomainCookies: { domain: 'example.com' },
        },
      });

      expect((newResult.advanced as Record<string, unknown>).cookiePrefix).toBe('iam');
    });
  });
});

// ===================================================================================================================
// resolveCrossSubDomainCookies Tests
// ===================================================================================================================

describe('resolveCrossSubDomainCookies', () => {
  const resolvedUrlsWithBaseUrl = {
    appUrl: 'https://dev.turbo-ops.de',
    baseUrl: 'https://api.dev.turbo-ops.de',
    rpId: 'turbo-ops.de',
    warnings: [],
  };

  const resolvedUrlsLocalhost = {
    appUrl: 'http://localhost:3001',
    baseUrl: 'http://localhost:3000',
    rpId: 'localhost',
    warnings: [],
  };

  const resolvedUrlsEmpty = {
    appUrl: undefined,
    baseUrl: undefined,
    rpId: undefined,
    warnings: [],
  };

  describe('disabled cases', () => {
    it('should be disabled when undefined', () => {
      const result = resolveCrossSubDomainCookies({} as any, resolvedUrlsWithBaseUrl);
      expect(result).toEqual({ domain: undefined, enabled: false });
    });

    it('should be disabled when false', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: false } as any,
        resolvedUrlsWithBaseUrl,
      );
      expect(result).toEqual({ domain: undefined, enabled: false });
    });

    it('should be disabled when { enabled: false }', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: { enabled: false } } as any,
        resolvedUrlsWithBaseUrl,
      );
      expect(result).toEqual({ domain: undefined, enabled: false });
    });

    it('should be disabled when { enabled: false, domain: "example.com" } (pre-configured)', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: { domain: 'example.com', enabled: false } } as any,
        resolvedUrlsWithBaseUrl,
      );
      expect(result).toEqual({ domain: undefined, enabled: false });
    });

    it('should be disabled when null', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: null as any } as any,
        resolvedUrlsWithBaseUrl,
      );
      expect(result).toEqual({ domain: undefined, enabled: false });
    });
  });

  describe('enabled with auto-derived domain', () => {
    it('should derive domain from appUrl hostname (parent domain) when true', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: true } as any,
        resolvedUrlsWithBaseUrl,
      );
      // appUrl = 'https://dev.turbo-ops.de' → domain = 'dev.turbo-ops.de' (NOT api.dev.turbo-ops.de)
      expect(result).toEqual({ domain: 'dev.turbo-ops.de', enabled: true });
    });

    it('should derive domain from appUrl hostname when {}', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: {} } as any,
        resolvedUrlsWithBaseUrl,
      );
      expect(result).toEqual({ domain: 'dev.turbo-ops.de', enabled: true });
    });

    it('should strip api. prefix from baseUrl when appUrl is not available', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: true } as any,
        { ...resolvedUrlsEmpty, baseUrl: 'https://api.dev.example.com' },
      );
      // baseUrl = 'https://api.dev.example.com' → strip api. → 'dev.example.com'
      expect(result).toEqual({ domain: 'dev.example.com', enabled: true });
    });

    it('should use baseUrl hostname as-is when no api. prefix', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: true } as any,
        { ...resolvedUrlsEmpty, baseUrl: 'https://backend.example.com' },
      );
      expect(result).toEqual({ domain: 'backend.example.com', enabled: true });
    });

    it('should fallback to config.baseUrl with api. stripping when resolvedUrls empty', () => {
      const result = resolveCrossSubDomainCookies(
        { baseUrl: 'https://api.example.com', crossSubDomainCookies: true } as any,
        resolvedUrlsEmpty,
      );
      expect(result).toEqual({ domain: 'example.com', enabled: true });
    });

    it('should prefer appUrl over baseUrl for domain derivation', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: true } as any,
        {
          appUrl: 'https://app.custom.com',
          baseUrl: 'https://api.different.com',
          rpId: 'custom.com',
          warnings: [],
        },
      );
      // appUrl takes priority → 'app.custom.com'
      expect(result).toEqual({ domain: 'app.custom.com', enabled: true });
    });
  });

  describe('enabled with explicit domain', () => {
    it('should use explicit domain from config', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: { domain: 'example.com' } } as any,
        resolvedUrlsWithBaseUrl,
      );
      expect(result).toEqual({ domain: 'example.com', enabled: true });
    });

    it('should prefer explicit domain over auto-derived', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: { domain: 'custom.com' } } as any,
        resolvedUrlsWithBaseUrl,
      );
      expect(result).toEqual({ domain: 'custom.com', enabled: true });
    });
  });

  describe('localhost handling', () => {
    it('should be disabled when true with localhost baseUrl', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: true } as any,
        resolvedUrlsLocalhost,
      );
      expect(result).toEqual({ domain: undefined, enabled: false });
    });

    it('should be disabled when {} with 127.0.0.1 baseUrl', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: {} } as any,
        {
          ...resolvedUrlsLocalhost,
          baseUrl: 'http://127.0.0.1:3000',
        },
      );
      expect(result).toEqual({ domain: undefined, enabled: false });
    });
  });

  describe('missing baseUrl', () => {
    it('should be disabled when true but no baseUrl available', () => {
      const result = resolveCrossSubDomainCookies(
        { crossSubDomainCookies: true } as any,
        resolvedUrlsEmpty,
      );
      expect(result).toEqual({ domain: undefined, enabled: false });
    });
  });
});
