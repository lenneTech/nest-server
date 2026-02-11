/**
 * Unit tests for BetterAuthCookieHelper
 *
 * Tests the cookie domain feature, createCookieHelper factory,
 * and getDefaultCookieOptions behavior.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  BetterAuthCookieHelper,
  type BetterAuthCookieHelperConfig,
  createCookieHelper,
} from '../../src/core/modules/better-auth/core-better-auth-cookie.helper';

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
});
