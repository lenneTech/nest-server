/**
 * Story: Legacy Auth Rate Limiting
 *
 * As a developer using @lenne.tech/nest-server,
 * I want to protect Legacy Auth endpoints with rate limiting,
 * So that I can prevent brute-force attacks on authentication endpoints.
 *
 * This test file verifies the rate limiting functionality for Legacy Auth endpoints.
 *
 * Configuration via config.env.ts:
 * ```typescript
 * auth: {
 *   rateLimit: {
 *     enabled: true,
 *     max: 10,
 *     windowSeconds: 60,
 *     message: 'Too many login attempts, please try again later.',
 *   }
 * }
 * ```
 */

import { LegacyAuthRateLimiter } from '../../src';

describe('Story: Legacy Auth Rate Limiting', () => {
  // ===================================================================================================================
  // LegacyAuthRateLimiter Service Tests
  // ===================================================================================================================

  describe('LegacyAuthRateLimiter Service', () => {
    let rateLimiter: LegacyAuthRateLimiter;

    beforeEach(() => {
      rateLimiter = new LegacyAuthRateLimiter();
    });

    afterEach(() => {
      // Clean up the interval to prevent memory leaks
      rateLimiter.onModuleDestroy();
    });

    describe('Disabled State (Default - Backward Compatible)', () => {
      it('should be disabled by default', () => {
        expect(rateLimiter.isEnabled()).toBe(false);
      });

      it('should allow all requests when disabled', () => {
        const result = rateLimiter.check('192.168.1.1', 'signIn');

        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(Infinity);
        expect(result.remaining).toBe(Infinity);
      });

      it('should not throw when no configuration is provided', () => {
        // This tests backward compatibility - no config means rate limiting is off
        expect(() => {
          const result = rateLimiter.check('192.168.1.1', 'signIn');
          expect(result.allowed).toBe(true);
        }).not.toThrow();
      });

      it('should allow unlimited requests when disabled', () => {
        const ip = '192.168.1.100';

        // Make 100 requests - all should be allowed when disabled
        for (let i = 0; i < 100; i++) {
          const result = rateLimiter.check(ip, 'signIn');
          expect(result.allowed).toBe(true);
        }
      });
    });

    describe('Enabled State', () => {
      beforeEach(() => {
        rateLimiter.configure({
          enabled: true,
          max: 5,
          message: 'Too many login attempts',
          windowSeconds: 60,
        });
      });

      it('should be enabled after configuration', () => {
        expect(rateLimiter.isEnabled()).toBe(true);
      });

      it('should return configured message', () => {
        expect(rateLimiter.getMessage()).toBe('Too many login attempts');
      });

      it('should allow first request', () => {
        const result = rateLimiter.check('192.168.1.1', 'signIn');

        expect(result.allowed).toBe(true);
        expect(result.current).toBe(1);
        expect(result.remaining).toBe(4);
      });

      it('should track multiple requests from same IP', () => {
        const ip = '192.168.1.100';

        // First request
        const result1 = rateLimiter.check(ip, 'signIn');
        expect(result1.current).toBe(1);
        expect(result1.remaining).toBe(4);

        // Second request
        const result2 = rateLimiter.check(ip, 'signIn');
        expect(result2.current).toBe(2);
        expect(result2.remaining).toBe(3);

        // Third request
        const result3 = rateLimiter.check(ip, 'signIn');
        expect(result3.current).toBe(3);
        expect(result3.remaining).toBe(2);
      });

      it('should block requests after limit exceeded', () => {
        const ip = '192.168.1.101';

        // Make 5 allowed requests
        for (let i = 0; i < 5; i++) {
          const result = rateLimiter.check(ip, 'signIn');
          expect(result.allowed).toBe(true);
        }

        // 6th request should be blocked
        const blocked = rateLimiter.check(ip, 'signIn');
        expect(blocked.allowed).toBe(false);
        expect(blocked.remaining).toBe(0);
        expect(blocked.current).toBe(6);
      });

      it('should track different endpoints separately', () => {
        const ip = '192.168.1.102';

        // Make 5 requests to signIn
        for (let i = 0; i < 5; i++) {
          rateLimiter.check(ip, 'signIn');
        }

        // signIn should now be blocked
        const signInBlocked = rateLimiter.check(ip, 'signIn');
        expect(signInBlocked.allowed).toBe(false);

        // But signUp should still be allowed (different endpoint)
        const signUpAllowed = rateLimiter.check(ip, 'signUp');
        expect(signUpAllowed.allowed).toBe(true);
        expect(signUpAllowed.current).toBe(1);
      });

      it('should track different IPs separately', () => {
        const ip1 = '192.168.1.10';
        const ip2 = '192.168.1.11';

        // Exhaust limit for ip1
        for (let i = 0; i < 5; i++) {
          rateLimiter.check(ip1, 'signIn');
        }
        expect(rateLimiter.check(ip1, 'signIn').allowed).toBe(false);

        // ip2 should still be allowed
        const result = rateLimiter.check(ip2, 'signIn');
        expect(result.allowed).toBe(true);
        expect(result.current).toBe(1);
      });

      it('should provide resetIn time', () => {
        const result = rateLimiter.check('192.168.1.200', 'signIn');
        expect(result.resetIn).toBeGreaterThan(0);
        expect(result.resetIn).toBeLessThanOrEqual(60);
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
        const ip = '192.168.1.50';

        // Exhaust limit
        for (let i = 0; i < 3; i++) {
          rateLimiter.check(ip, 'signIn');
        }
        expect(rateLimiter.check(ip, 'signIn').allowed).toBe(false);

        // Reset
        rateLimiter.reset(ip);

        // Should be allowed again
        const result = rateLimiter.check(ip, 'signIn');
        expect(result.allowed).toBe(true);
        expect(result.current).toBe(1);
      });

      it('should clear all entries', () => {
        rateLimiter.check('192.168.1.1', 'signIn');
        rateLimiter.check('192.168.1.2', 'signIn');

        const statsBefore = rateLimiter.getStats();
        expect(statsBefore.activeEntries).toBeGreaterThan(0);

        rateLimiter.clear();

        const statsAfter = rateLimiter.getStats();
        expect(statsAfter.activeEntries).toBe(0);
      });
    });

    describe('Statistics', () => {
      it('should report enabled status', () => {
        expect(rateLimiter.getStats().enabled).toBe(false);

        rateLimiter.configure({ enabled: true });

        expect(rateLimiter.getStats().enabled).toBe(true);
      });

      it('should report active entries count', () => {
        rateLimiter.configure({ enabled: true });

        expect(rateLimiter.getStats().activeEntries).toBe(0);

        rateLimiter.check('192.168.1.1', 'signIn');
        expect(rateLimiter.getStats().activeEntries).toBe(1);

        rateLimiter.check('192.168.1.2', 'signUp');
        expect(rateLimiter.getStats().activeEntries).toBe(2);
      });
    });

    describe('Configuration Defaults - Presence Implies Enabled Pattern', () => {
      it('should enable with defaults when empty object is passed', () => {
        // Just passing {} should enable with all default values
        rateLimiter.configure({});

        expect(rateLimiter.isEnabled()).toBe(true);

        // Should use defaults: max=10, windowSeconds=60
        const ip = '192.168.1.200';
        for (let i = 0; i < 10; i++) {
          expect(rateLimiter.check(ip, 'signIn').allowed).toBe(true);
        }
        expect(rateLimiter.check(ip, 'signIn').allowed).toBe(false);
      });

      it('should use default message when not configured', () => {
        rateLimiter.configure({});
        expect(rateLimiter.getMessage()).toBe('Too many requests, please try again later.');
      });

      it('should stay disabled when config is undefined (backward compatible)', () => {
        rateLimiter.configure(undefined);
        expect(rateLimiter.isEnabled()).toBe(false);
      });

      it('should stay disabled when config is null (backward compatible)', () => {
        rateLimiter.configure(null);
        expect(rateLimiter.isEnabled()).toBe(false);
      });

      it('should allow pre-configuring without enabling via enabled: false', () => {
        rateLimiter.configure({
          enabled: false,
          max: 20,
          message: 'Pre-configured but disabled',
          windowSeconds: 120,
        });

        expect(rateLimiter.isEnabled()).toBe(false);
        // All requests should be allowed when disabled
        expect(rateLimiter.check('192.168.1.1', 'signIn').allowed).toBe(true);
      });

      it('should enable automatically when any config property is set', () => {
        // Just setting max should enable the feature
        rateLimiter.configure({ max: 5 });
        expect(rateLimiter.isEnabled()).toBe(true);

        // Use configured max
        const ip = '192.168.1.201';
        for (let i = 0; i < 5; i++) {
          expect(rateLimiter.check(ip, 'signIn').allowed).toBe(true);
        }
        expect(rateLimiter.check(ip, 'signIn').allowed).toBe(false);
      });
    });

    describe('IP Masking for Logging', () => {
      beforeEach(() => {
        rateLimiter.configure({
          enabled: true,
          max: 1,
        });
      });

      it('should handle IPv4 addresses', () => {
        // This tests that the rate limiter can process IPv4 addresses
        const result = rateLimiter.check('192.168.1.1', 'signIn');
        expect(result.allowed).toBe(true);
      });

      it('should handle IPv6 addresses', () => {
        // This tests that the rate limiter can process IPv6 addresses
        const result = rateLimiter.check('2001:db8:85a3::8a2e:370:7334', 'signIn');
        expect(result.allowed).toBe(true);
      });

      it('should handle localhost addresses', () => {
        const result1 = rateLimiter.check('127.0.0.1', 'signIn');
        expect(result1.allowed).toBe(true);

        const result2 = rateLimiter.check('::1', 'signUp');
        expect(result2.allowed).toBe(true);
      });
    });
  });
});
