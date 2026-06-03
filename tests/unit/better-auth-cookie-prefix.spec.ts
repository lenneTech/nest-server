/**
 * Unit tests for resolveBetterAuthCookiePrefix.
 *
 * Precedence:
 *   1. COOKIE_PREFIX env (dedicated, always wins) — for fully autonomous cookie
 *      isolation on a shared host. Mirrors the frontend NUXT_PUBLIC_COOKIE_PREFIX.
 *   2. basePath-derived prefix ('/iam' → 'iam') — backward-compatible default.
 */
import { describe, expect, it } from 'vitest';

import {
  detectCookiePrefixDrift,
  resolveBetterAuthCookiePrefix,
  resolveBetterAuthSessionCookieName,
} from '../../src/core/modules/better-auth/better-auth-cookie-prefix.helper';

describe('resolveBetterAuthCookiePrefix', () => {
  describe('basePath-derived default (no COOKIE_PREFIX)', () => {
    it("derives 'iam' from '/iam'", () => {
      expect(resolveBetterAuthCookiePrefix('/iam', {})).toBe('iam');
    });

    it("derives 'api.iam' from '/api/iam' (slashes → dots)", () => {
      expect(resolveBetterAuthCookiePrefix('/api/iam', {})).toBe('api.iam');
    });

    it('falls back to /iam when basePath is empty', () => {
      expect(resolveBetterAuthCookiePrefix('', {})).toBe('iam');
    });

    it('ignores an empty COOKIE_PREFIX and uses the basePath default', () => {
      expect(resolveBetterAuthCookiePrefix('/iam', { COOKIE_PREFIX: '' })).toBe('iam');
    });

    it('ignores a whitespace-only COOKIE_PREFIX', () => {
      expect(resolveBetterAuthCookiePrefix('/iam', { COOKIE_PREFIX: '   ' })).toBe('iam');
    });
  });

  describe('COOKIE_PREFIX env (always wins)', () => {
    it('overrides the basePath-derived prefix', () => {
      expect(resolveBetterAuthCookiePrefix('/iam', { COOKIE_PREFIX: 'acme' })).toBe('acme');
    });

    it('overrides even a multi-segment basePath', () => {
      expect(resolveBetterAuthCookiePrefix('/api/iam', { COOKIE_PREFIX: 'kit-test' })).toBe('kit-test');
    });

    it('trims surrounding whitespace', () => {
      expect(resolveBetterAuthCookiePrefix('/iam', { COOKIE_PREFIX: '  acme  ' })).toBe('acme');
    });
  });

  describe('sanitisation (mirrors the frontend resolver)', () => {
    it('keeps the safe cookie-name subset [A-Za-z0-9._-]', () => {
      expect(resolveBetterAuthCookiePrefix('/iam', { COOKIE_PREFIX: 'Acme.kit-test_01' })).toBe('Acme.kit-test_01');
    });

    it('strips characters that would corrupt a Set-Cookie header', () => {
      expect(resolveBetterAuthCookiePrefix('/iam', { COOKIE_PREFIX: 'a;c=me x\r\n' })).toBe('acmex');
    });

    it('falls back to the basePath default when the prefix sanitises to empty', () => {
      expect(resolveBetterAuthCookiePrefix('/iam', { COOKIE_PREFIX: ';;==' })).toBe('iam');
    });
  });
});

describe('resolveBetterAuthSessionCookieName', () => {
  it("derives '<basePath>.session_token' by default", () => {
    expect(resolveBetterAuthSessionCookieName('/iam', {})).toBe('iam.session_token');
  });

  it('honours the COOKIE_PREFIX override', () => {
    expect(resolveBetterAuthSessionCookieName('/iam', { COOKIE_PREFIX: 'acme' })).toBe('acme.session_token');
  });

  it('sanitises the override before composing the name', () => {
    expect(resolveBetterAuthSessionCookieName('/iam', { COOKIE_PREFIX: 'a;c=me' })).toBe('acme.session_token');
  });
});

describe('detectCookiePrefixDrift', () => {
  it('returns null when there is no advanced object', () => {
    expect(detectCookiePrefixDrift('iam', undefined)).toBeNull();
    expect(detectCookiePrefixDrift('iam', null)).toBeNull();
  });

  it('returns null when advanced has no cookiePrefix', () => {
    expect(detectCookiePrefixDrift('iam', { foo: 'bar' })).toBeNull();
  });

  it('returns null when programmatic prefix matches resolved prefix', () => {
    expect(detectCookiePrefixDrift('iam', { cookiePrefix: 'iam' })).toBeNull();
  });

  it('returns null when programmatic cookiePrefix is not a string', () => {
    expect(detectCookiePrefixDrift('iam', { cookiePrefix: 123 })).toBeNull();
  });

  it('returns a warning sentence when programmatic and resolved prefixes diverge', () => {
    const warning = detectCookiePrefixDrift('acme', { cookiePrefix: 'kit-test' });
    expect(warning).toContain('options.advanced.cookiePrefix="kit-test"');
    expect(warning).toContain('NestJS layer still uses "acme"');
    expect(warning).toContain('COOKIE_PREFIX env variable');
  });
});
