/**
 * Unit tests for BetterAuthCookieHelper
 *
 * Tests the cookie domain feature, createCookieHelper factory,
 * and getDefaultCookieOptions behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BetterAuthCookieHelper,
  type BetterAuthCookieHelperConfig,
  createCookieHelper,
} from '../../src/core/modules/better-auth/core-better-auth-cookie.helper';
import { extractSessionToken } from '../../src/core/modules/better-auth/core-better-auth-web.helper';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';
import { TestHelper } from '../../src/test/test.helper';

describe('BetterAuthCookieHelper', () => {
  /**
   * Helper to create a minimal config for testing
   */
  function createConfig(overrides: Partial<BetterAuthCookieHelperConfig> = {}): BetterAuthCookieHelperConfig {
    return {
      basePath: '/iam',
      ...overrides,
    };
  }

  describe('getDefaultCookieOptions', () => {
    it('should return base options without domain when domain is not configured', () => {
      const helper = new BetterAuthCookieHelper(createConfig());
      const options = helper.getDefaultCookieOptions();

      expect(options).toEqual({
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // NODE_ENV !== 'production' in tests
      });
      expect(options).not.toHaveProperty('domain');
    });

    it('should include domain when domain is configured', () => {
      const helper = new BetterAuthCookieHelper(createConfig({ domain: 'example.com' }));
      const options = helper.getDefaultCookieOptions();

      expect(options).toEqual({
        domain: 'example.com',
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
      });
    });

    it('should not include domain when domain is undefined', () => {
      const helper = new BetterAuthCookieHelper(createConfig({ domain: undefined }));
      const options = helper.getDefaultCookieOptions();

      expect(Object.keys(options)).not.toContain('domain');
    });

    it('should not include domain when domain is empty string', () => {
      const helper = new BetterAuthCookieHelper(createConfig({ domain: '' }));
      const options = helper.getDefaultCookieOptions();

      expect(Object.keys(options)).not.toContain('domain');
    });

    it('should propagate domain to setSessionCookies', () => {
      const helper = new BetterAuthCookieHelper(createConfig({
        domain: 'example.com',
        secret: 'test-secret',
      }));

      const cookieCalls: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
      const mockRes = {
        cookie: vi.fn((name: string, value: string, options: Record<string, unknown>) => {
          cookieCalls.push({ name, options, value });
        }),
      } as any;

      helper.setSessionCookies(mockRes, 'test-session-token');

      expect(cookieCalls).toHaveLength(1);
      expect(cookieCalls[0].name).toBe('iam.session_token');
      expect(cookieCalls[0].options.domain).toBe('example.com');
    });

    it('should propagate domain to clearSessionCookies', () => {
      const helper = new BetterAuthCookieHelper(createConfig({
        domain: 'example.com',
      }));

      const cookieCalls: Array<{ name: string; options: Record<string, unknown> }> = [];
      const mockRes = {
        cookie: vi.fn((name: string, _value: string, options: Record<string, unknown>) => {
          cookieCalls.push({ name, options });
        }),
      } as any;

      helper.clearSessionCookies(mockRes);

      expect(cookieCalls).toHaveLength(1);
      expect(cookieCalls[0].options.domain).toBe('example.com');
      expect(cookieCalls[0].options.maxAge).toBe(0);
    });

    it('should not set domain on cookies when domain is not configured', () => {
      const helper = new BetterAuthCookieHelper(createConfig({
        secret: 'test-secret',
      }));

      const cookieCalls: Array<{ options: Record<string, unknown> }> = [];
      const mockRes = {
        cookie: vi.fn((_name: string, _value: string, options: Record<string, unknown>) => {
          cookieCalls.push({ options });
        }),
      } as any;

      helper.setSessionCookies(mockRes, 'test-session-token');

      expect(cookieCalls[0].options).not.toHaveProperty('domain');
    });
  });

  describe('createCookieHelper factory', () => {
    it('should create helper without domain when not provided', () => {
      const helper = createCookieHelper('/iam');
      const options = helper.getDefaultCookieOptions();

      expect(Object.keys(options)).not.toContain('domain');
    });

    it('should create helper with domain when provided', () => {
      const helper = createCookieHelper('/iam', { domain: 'example.com' });
      const options = helper.getDefaultCookieOptions();

      expect(options.domain).toBe('example.com');
    });

    it('should pass all options through correctly', () => {
      const helper = createCookieHelper('/iam', {
        domain: 'test.example.com',
        legacyCookieEnabled: true,
        secret: 'my-secret',
      });

      const options = helper.getDefaultCookieOptions();
      expect(options.domain).toBe('test.example.com');

      // Verify legacy cookie is enabled by checking cookie count
      const cookieCalls: string[] = [];
      const mockRes = {
        cookie: vi.fn((name: string) => cookieCalls.push(name)),
      } as any;
      helper.setSessionCookies(mockRes, 'token');

      // Should set both native and legacy cookie
      expect(cookieCalls).toContain('iam.session_token');
      expect(cookieCalls).toContain('token');
    });

    it('should default legacyCookieEnabled to false', () => {
      const helper = createCookieHelper('/iam', { domain: 'example.com' });

      const cookieCalls: string[] = [];
      const mockRes = {
        cookie: vi.fn((name: string) => cookieCalls.push(name)),
      } as any;
      helper.setSessionCookies(mockRes, 'token');

      // Only native cookie, no legacy
      expect(cookieCalls).toEqual(['iam.session_token']);
    });
  });

  /**
   * Cross-layer lockstep under a COOKIE_PREFIX override.
   *
   * Regression guard for the bug where the session cookie name was derived from
   * basePath INDEPENDENTLY in several places: Better-Auth set `acme.session_token`
   * while the NestJS read/clear path still looked for `iam.session_token`, so a
   * COOKIE_PREFIX override silently broke sign-in / authenticated requests / logout.
   *
   * This exercises the SET path (helper) and the READ path (extractSessionToken)
   * together — exactly what a sign-in → request → sign-out e2e would catch — but
   * deterministically and without a database.
   */
  describe('COOKIE_PREFIX override (cross-layer lockstep)', () => {
    const previousCookiePrefix = process.env.COOKIE_PREFIX;

    beforeEach(() => {
      process.env.COOKIE_PREFIX = 'acme';
    });

    afterEach(() => {
      if (previousCookiePrefix === undefined) {
        delete process.env.COOKIE_PREFIX;
      } else {
        process.env.COOKIE_PREFIX = previousCookiePrefix;
      }
    });

    it('SET path: helper uses the overridden cookie name', () => {
      const helper = new BetterAuthCookieHelper({ basePath: '/iam', secret: 'test-secret' });
      expect(helper.getCookieName()).toBe('acme.session_token');

      const cookieCalls: string[] = [];
      const mockRes = { cookie: vi.fn((name: string) => cookieCalls.push(name)) } as any;
      helper.setSessionCookies(mockRes, 'tok');
      expect(cookieCalls).toContain('acme.session_token');

      const clearCalls: string[] = [];
      const clearRes = { cookie: vi.fn((name: string) => clearCalls.push(name)) } as any;
      helper.clearSessionCookies(clearRes);
      expect(clearCalls).toContain('acme.session_token');
    });

    it('READ path: extractSessionToken reads the overridden cookie the SET path wrote', () => {
      const req = { cookies: { 'acme.session_token': 'tok' }, headers: {} } as any;
      expect(extractSessionToken(req, '/iam', { skipAuthHeader: true })).toBe('tok');
    });

    it('READ path: the old basePath-derived name is NO LONGER honoured under override (catches the bug)', () => {
      // With the previous per-site derivation this would still resolve 'tok';
      // now the read path resolves through the same resolver, so it must miss.
      const req = { cookies: { 'iam.session_token': 'tok' }, headers: {} } as any;
      expect(extractSessionToken(req, '/iam', { skipAuthHeader: true })).toBeNull();
    });

    it('TestHelper.extractSessionToken: default cookie name follows the COOKIE_PREFIX override', () => {
      // A test that calls extractSessionToken(res) WITHOUT an explicit name
      // would silently return null under a COOKIE_PREFIX=acme app if the
      // default was still the hardcoded 'iam.session_token'.
      const response = {
        headers: { 'set-cookie': ['acme.session_token=secret-token; Path=/; HttpOnly'] },
      };
      expect(TestHelper.extractSessionToken(response)).toBe('secret-token');
    });

    it('Service cache: getCookiePrefix freezes the value on first read so a late env mutation cannot drift', () => {
      // Service is constructed BEFORE process.env.COOKIE_PREFIX changes — this
      // simulates a forked test worker that boots Better-Auth and only then a
      // sibling test mutates the env. Without the cache, getCookiePrefix would
      // return the new value while the Better-Auth instance is still pinned to
      // the old one.
      // ts-expect-error — bypass DI by passing all-undefined to the constructor.
      const service: any = new (CoreBetterAuthService as any)(null, undefined, { basePath: '/iam' });

      expect(service.getCookiePrefix()).toBe('acme');
      const cookieName = service.getSessionCookieName();
      expect(cookieName).toBe('acme.session_token');

      // Late mutation — must NOT change what the service reports.
      process.env.COOKIE_PREFIX = 'kit-test';
      expect(service.getCookiePrefix()).toBe('acme');
      expect(service.getSessionCookieName()).toBe('acme.session_token');
    });
  });
});
