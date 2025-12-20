/**
 * Story: BetterAuth Rate Limiting
 *
 * As a developer using @lenne.tech/nest-server,
 * I want to protect Better-Auth endpoints with rate limiting,
 * So that I can prevent brute-force attacks on authentication endpoints.
 *
 * This test file verifies the rate limiting functionality for Better-Auth endpoints.
 */

import { BetterAuthRateLimiter } from '../../src';

describe('Story: BetterAuth Rate Limiting', () => {
  // ===================================================================================================================
  // BetterAuthRateLimiter Service Tests
  // ===================================================================================================================

  describe('BetterAuthRateLimiter Service', () => {
    let rateLimiter: BetterAuthRateLimiter;

    beforeEach(() => {
      rateLimiter = new BetterAuthRateLimiter();
    });

    afterEach(() => {
      // Clean up the interval to prevent memory leaks
      rateLimiter.onModuleDestroy();
    });

    describe('Disabled State', () => {
      it('should be disabled by default', () => {
        expect(rateLimiter.isEnabled()).toBe(false);
      });

      it('should allow all requests when disabled', () => {
        const result = rateLimiter.check('192.168.1.1', '/sign-in');

        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(Infinity);
        expect(result.remaining).toBe(Infinity);
      });
    });

    describe('Enabled State', () => {
      beforeEach(() => {
        rateLimiter.configure({
          enabled: true,
          max: 5,
          message: 'Too many requests',
          skipEndpoints: ['/session'],
          strictEndpoints: ['/sign-in', '/sign-up'],
          windowSeconds: 60,
        });
      });

      it('should be enabled after configuration', () => {
        expect(rateLimiter.isEnabled()).toBe(true);
      });

      it('should return configured message', () => {
        expect(rateLimiter.getMessage()).toBe('Too many requests');
      });

      it('should allow first request', () => {
        const result = rateLimiter.check('192.168.1.1', '/sign-in');

        expect(result.allowed).toBe(true);
        expect(result.current).toBe(1);
        expect(result.remaining).toBeGreaterThan(0);
      });

      it('should track multiple requests from same IP', () => {
        const ip = '192.168.1.100';

        // First request
        const result1 = rateLimiter.check(ip, '/sign-in');
        expect(result1.current).toBe(1);
        // Strict endpoint has half the limit: ceil(5/2) = 3, so remaining after first = 3-1 = 2
        expect(result1.remaining).toBe(2);

        // Second request
        const result2 = rateLimiter.check(ip, '/sign-in');
        expect(result2.current).toBe(2);
        expect(result2.remaining).toBe(1);

        // Third request - should still be allowed (limit is 3)
        const result3 = rateLimiter.check(ip, '/sign-in');
        expect(result3.current).toBe(3);
        expect(result3.remaining).toBe(0);
        expect(result3.allowed).toBe(true);

        // Fourth request - should be blocked
        const result4 = rateLimiter.check(ip, '/sign-in');
        expect(result4.allowed).toBe(false);
        expect(result4.remaining).toBe(0);
      });

      it('should apply stricter limits for strict endpoints', () => {
        const ip = '192.168.1.101';

        // Strict endpoints get half the max (5/2 = 3 rounded up)
        // So we can make 3 requests before being blocked
        for (let i = 0; i < 3; i++) {
          const result = rateLimiter.check(ip, '/sign-in');
          expect(result.allowed).toBe(true);
        }

        // Fourth request should be blocked
        const result = rateLimiter.check(ip, '/sign-in');
        expect(result.allowed).toBe(false);
      });

      it('should use normal limits for non-strict endpoints', () => {
        const ip = '192.168.1.102';

        // Non-strict endpoints get the full max (5)
        for (let i = 0; i < 5; i++) {
          const result = rateLimiter.check(ip, '/profile');
          expect(result.allowed).toBe(true);
        }

        // Sixth request should be blocked
        const result = rateLimiter.check(ip, '/profile');
        expect(result.allowed).toBe(false);
      });

      it('should skip rate limiting for skip endpoints', () => {
        const ip = '192.168.1.103';

        // Session endpoint should skip rate limiting
        for (let i = 0; i < 100; i++) {
          const result = rateLimiter.check(ip, '/session');
          expect(result.allowed).toBe(true);
          expect(result.limit).toBe(Infinity);
        }
      });

      it('should track different IPs independently', () => {
        // Both IPs should be able to make their full quota
        const result1 = rateLimiter.check('192.168.1.1', '/profile');
        const result2 = rateLimiter.check('192.168.1.2', '/profile');

        expect(result1.allowed).toBe(true);
        expect(result1.current).toBe(1);

        expect(result2.allowed).toBe(true);
        expect(result2.current).toBe(1);
      });

      it('should track different endpoints independently for same IP', () => {
        const ip = '192.168.1.104';

        // Make requests to different endpoints
        const result1 = rateLimiter.check(ip, '/profile');
        const result2 = rateLimiter.check(ip, '/settings');

        // Each endpoint should have its own counter
        expect(result1.current).toBe(1);
        expect(result2.current).toBe(1);
      });
    });

    describe('Reset Functionality', () => {
      beforeEach(() => {
        rateLimiter.configure({
          enabled: true,
          max: 3,
          windowSeconds: 60,
        });
      });

      it('should reset rate limit for specific IP', () => {
        const ip = '192.168.1.200';

        // Make some requests
        rateLimiter.check(ip, '/sign-in');
        rateLimiter.check(ip, '/sign-in');

        // Reset for this IP
        rateLimiter.reset(ip);

        // Should start fresh
        const result = rateLimiter.check(ip, '/sign-in');
        expect(result.current).toBe(1);
      });

      it('should not affect other IPs when resetting one', () => {
        const ip1 = '192.168.1.201';
        const ip2 = '192.168.1.202';

        // Make requests from both IPs
        rateLimiter.check(ip1, '/sign-in');
        rateLimiter.check(ip2, '/sign-in');

        // Reset only ip1
        rateLimiter.reset(ip1);

        // ip1 should start fresh
        const result1 = rateLimiter.check(ip1, '/sign-in');
        expect(result1.current).toBe(1);

        // ip2 should continue counting
        const result2 = rateLimiter.check(ip2, '/sign-in');
        expect(result2.current).toBe(2);
      });

      it('should clear all entries', () => {
        rateLimiter.check('192.168.1.1', '/sign-in');
        rateLimiter.check('192.168.1.2', '/sign-in');
        rateLimiter.check('192.168.1.3', '/sign-in');

        const statsBefore = rateLimiter.getStats();
        expect(statsBefore.activeEntries).toBeGreaterThan(0);

        rateLimiter.clear();

        const statsAfter = rateLimiter.getStats();
        expect(statsAfter.activeEntries).toBe(0);
      });
    });

    describe('Statistics', () => {
      it('should return correct stats when disabled', () => {
        const stats = rateLimiter.getStats();

        expect(stats.enabled).toBe(false);
        expect(stats.activeEntries).toBe(0);
      });

      it('should return correct stats when enabled', () => {
        rateLimiter.configure({
          enabled: true,
          max: 10,
          windowSeconds: 60,
        });

        rateLimiter.check('192.168.1.1', '/test1');
        rateLimiter.check('192.168.1.2', '/test2');

        const stats = rateLimiter.getStats();

        expect(stats.enabled).toBe(true);
        expect(stats.activeEntries).toBe(2);
      });
    });

    describe('Reset Time Calculation', () => {
      beforeEach(() => {
        rateLimiter.configure({
          enabled: true,
          max: 5,
          windowSeconds: 60,
        });
      });

      it('should return correct resetIn value', () => {
        const result = rateLimiter.check('192.168.1.1', '/test');

        // resetIn should be close to windowSeconds for first request
        expect(result.resetIn).toBeGreaterThan(50);
        expect(result.resetIn).toBeLessThanOrEqual(60);
      });
    });

    describe('Endpoint Normalization', () => {
      beforeEach(() => {
        rateLimiter.configure({
          enabled: true,
          max: 5,
          skipEndpoints: ['/callback'],
          windowSeconds: 60,
        });
      });

      it('should skip callback endpoints', () => {
        const result = rateLimiter.check('192.168.1.1', '/callback/google');

        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(Infinity);
      });

      it('should handle query strings correctly', () => {
        const ip = '192.168.1.1';

        // Requests with different query strings should be grouped together
        const result1 = rateLimiter.check(ip, '/profile?foo=bar');
        const result2 = rateLimiter.check(ip, '/profile?baz=qux');

        // Both should count toward the same endpoint
        expect(result1.current).toBe(1);
        expect(result2.current).toBe(2);
      });
    });
  });

  // ===================================================================================================================
  // Rate Limiting Configuration Tests
  // ===================================================================================================================

  describe('Rate Limiting Configuration', () => {
    const mockConfigService = {
      get: (key: string) => {
        if (key === 'betterAuth') {
          return {
            enabled: false,
            rateLimit: {
              enabled: true,
              max: 10,
              message: 'Rate limited',
              skipEndpoints: ['/session'],
              strictEndpoints: ['/sign-in'],
              windowSeconds: 30,
            },
          };
        }
        return undefined;
      },
    };

    it('should have rate limit configuration in betterAuth config', () => {
      const config = mockConfigService.get('betterAuth');

      expect(config.rateLimit).toBeDefined();
      expect(config.rateLimit.enabled).toBe(true);
      expect(config.rateLimit.max).toBe(10);
      expect(config.rateLimit.windowSeconds).toBe(30);
    });

    it('should have message configuration', () => {
      const config = mockConfigService.get('betterAuth');

      expect(config.rateLimit.message).toBe('Rate limited');
    });

    it('should have strictEndpoints configuration', () => {
      const config = mockConfigService.get('betterAuth');

      expect(config.rateLimit.strictEndpoints).toContain('/sign-in');
    });

    it('should have skipEndpoints configuration', () => {
      const config = mockConfigService.get('betterAuth');

      expect(config.rateLimit.skipEndpoints).toContain('/session');
    });
  });

  // ===================================================================================================================
  // Module Integration Tests
  // ===================================================================================================================

  describe('Rate Limiter Module Integration', () => {
    it('should create BetterAuthRateLimiter service', () => {
      // Test that the rate limiter can be instantiated standalone
      const rateLimiter = new BetterAuthRateLimiter();
      expect(rateLimiter).toBeDefined();
      expect(typeof rateLimiter.check).toBe('function');
      expect(typeof rateLimiter.isEnabled).toBe('function');
      expect(typeof rateLimiter.configure).toBe('function');
      expect(typeof rateLimiter.reset).toBe('function');
      expect(typeof rateLimiter.clear).toBe('function');
      expect(typeof rateLimiter.getStats).toBe('function');
      expect(typeof rateLimiter.getMessage).toBe('function');

      // Cleanup
      rateLimiter.onModuleDestroy();
    });

    it('should be configurable after instantiation', () => {
      const rateLimiter = new BetterAuthRateLimiter();

      // Initially disabled
      expect(rateLimiter.isEnabled()).toBe(false);

      // Configure to enable
      rateLimiter.configure({
        enabled: true,
        max: 10,
        windowSeconds: 60,
      });

      expect(rateLimiter.isEnabled()).toBe(true);

      // Cleanup
      rateLimiter.onModuleDestroy();
    });
  });

  // ===================================================================================================================
  // Edge Cases
  // ===================================================================================================================

  describe('Edge Cases', () => {
    let rateLimiter: BetterAuthRateLimiter;

    beforeEach(() => {
      rateLimiter = new BetterAuthRateLimiter();
      rateLimiter.configure({
        enabled: true,
        max: 10,
        windowSeconds: 60,
      });
    });

    afterEach(() => {
      rateLimiter.onModuleDestroy();
    });

    it('should handle empty IP address', () => {
      const result = rateLimiter.check('', '/test');

      expect(result.allowed).toBe(true);
    });

    it('should handle empty path', () => {
      const result = rateLimiter.check('192.168.1.1', '');

      expect(result.allowed).toBe(true);
    });

    it('should handle IPv6 addresses', () => {
      const result = rateLimiter.check('::1', '/test');

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
    });

    it('should handle long IP addresses', () => {
      const result = rateLimiter.check('2001:0db8:85a3:0000:0000:8a2e:0370:7334', '/test');

      expect(result.allowed).toBe(true);
    });

    it('should handle special characters in path', () => {
      const result = rateLimiter.check('192.168.1.1', '/test/path%20with%20spaces');

      expect(result.allowed).toBe(true);
    });

    it('should handle reconfiguration', () => {
      // Make some requests with initial config
      rateLimiter.check('192.168.1.1', '/test');
      rateLimiter.check('192.168.1.1', '/test');

      // Reconfigure with different settings
      rateLimiter.configure({
        enabled: true,
        max: 5,
        windowSeconds: 30,
      });

      // Should still be enabled
      expect(rateLimiter.isEnabled()).toBe(true);

      // Existing entries should still be tracked
      // (reconfiguration doesn't clear the store)
      const result = rateLimiter.check('192.168.1.1', '/test');
      expect(result.current).toBe(3);
    });

    it('should handle disabling after being enabled', () => {
      // Make requests while enabled
      rateLimiter.check('192.168.1.1', '/test');

      // Disable rate limiting
      rateLimiter.configure({
        enabled: false,
      });

      expect(rateLimiter.isEnabled()).toBe(false);

      // Should allow all requests now
      const result = rateLimiter.check('192.168.1.1', '/test');
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(Infinity);
    });
  });

  // ===================================================================================================================
  // Default Configuration Tests
  // ===================================================================================================================

  describe('Default Configuration', () => {
    let rateLimiter: BetterAuthRateLimiter;

    beforeEach(() => {
      rateLimiter = new BetterAuthRateLimiter();
      // Enable with minimal config to use defaults
      rateLimiter.configure({
        enabled: true,
      });
    });

    afterEach(() => {
      rateLimiter.onModuleDestroy();
    });

    it('should use default max of 10', () => {
      const ip = '192.168.1.1';

      // Make 10 requests (should all be allowed)
      for (let i = 0; i < 10; i++) {
        const result = rateLimiter.check(ip, '/profile');
        expect(result.allowed).toBe(true);
      }

      // 11th request should be blocked
      const result = rateLimiter.check(ip, '/profile');
      expect(result.allowed).toBe(false);
    });

    it('should use default message', () => {
      expect(rateLimiter.getMessage()).toBe('Too many requests, please try again later.');
    });

    it('should use default skip endpoints', () => {
      // /session should be skipped by default
      for (let i = 0; i < 100; i++) {
        const result = rateLimiter.check('192.168.1.1', '/session');
        expect(result.allowed).toBe(true);
      }
    });

    it('should use default strict endpoints', () => {
      const ip = '192.168.1.1';

      // /sign-in is a strict endpoint by default (limit = 5)
      for (let i = 0; i < 5; i++) {
        const result = rateLimiter.check(ip, '/sign-in');
        expect(result.allowed).toBe(true);
      }

      // 6th request should be blocked
      const result = rateLimiter.check(ip, '/sign-in');
      expect(result.allowed).toBe(false);
    });
  });
});
