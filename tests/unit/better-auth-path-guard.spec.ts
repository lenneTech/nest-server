import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalRequestPath,
  CoreBetterAuthPathGuardMiddleware,
  CoreBetterAuthRateLimiter,
  CoreBetterAuthRateLimitMiddleware,
  hasNonCanonicalPathSegments,
  pathContainsSegments,
} from '../../src';

/**
 * Every check under the Better-Auth base path reads the path as SENT; Better-Auth routes the path `new URL()` resolved.
 * The guard refuses paths the two read differently, the limiter decides on the resolved path.
 */
describe('Better-Auth path guard', () => {
  /**
   * @regression   12.2.x — a dot segment under the base path made the rate limiter skip a sign-in as a callback
   *   (`/callback/../sign-in/email`), because every check read the raw path while Better-Auth resolved it.
   * @seen-failing Let dot segments through in hasNonCanonicalPathSegments()
   *   (src/core/modules/better-auth/core-better-auth-path-guard.middleware.ts) — registered as mutation
   *   `iam-path-guard-dot-segments-allowed` in tests/regression-mutations.json.
   */
  it.each([
    '/iam/callback/../sign-in/email',
    '/iam/./sign-in/email',
    '/iam/callback/%2e%2e/sign-in/email',
    '/iam/callback/%2E%2e/sign-in/email',
    '/iam/callback/.%2e/sign-in/email',
    '/iam/%2e/sign-in/email',
    '/iam/sign-in/email/..',
  ])('refuses a dot segment: %s', (path) => {
    expect(hasNonCanonicalPathSegments(path)).toBe(true);
  });

  it.each([
    '/iam/callback\\..\\sign-in/email',
    '/iam/callback%2f..%2fsign-in/email',
    '/iam/callback%2F..%2Fsign-in/email',
    '/iam/callback%5c..%5csign-in/email',
    '/iam/sign-up/email#x',
  ])('refuses a backslash, an encoded separator or a fragment: %s', (path) => {
    expect(hasNonCanonicalPathSegments(path)).toBe(true);
  });

  it.each([
    '/iam/sign-in/email',
    '/iam/callback/google',
    '/iam/reset-password/abc.def-123',
    '/iam/...',
    '/iam/%2e%2e%2e',
    '/iam/a.b/c',
    '/iam//sign-in/email',
    '/iam/',
    '/iam/name%20with%20space',
  ])('lets a canonical path through: %s', (path) => {
    expect(hasNonCanonicalPathSegments(path)).toBe(false);
  });

  it('stays linear on a long path from an unauthenticated request', () => {
    const path = `/iam/${'a/'.repeat(8000)}x`;
    const started = performance.now();
    expect(hasNonCanonicalPathSegments(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('answers 400 with its own error code and stops the chain', () => {
    const guard = new CoreBetterAuthPathGuardMiddleware();
    const next = vi.fn();
    const call = () => guard.use({ originalUrl: '/iam/callback/../sign-in/email' } as any, {} as any, next);
    expect(call).toThrow(BadRequestException);
    expect(call).toThrow(/LTNS_0305/);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a canonical path on and ignores the query string', () => {
    const guard = new CoreBetterAuthPathGuardMiddleware();
    const next = vi.fn();
    guard.use({ originalUrl: '/iam/callback/google?redirect=../x' } as any, {} as any, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('resolves a path the way Better-Auth routes it', () => {
    expect(canonicalRequestPath('/callback/../sign-in/email')).toBe('/sign-in/email');
    expect(canonicalRequestPath('/callback/%2e%2e/sign-in/email')).toBe('/sign-in/email');
    expect(canonicalRequestPath('/callback\\..\\sign-in/email')).toBe('/sign-in/email');
    expect(canonicalRequestPath('/sign-in/email?x=1')).toBe('/sign-in/email');
  });

  it('matches endpoints by whole segments', () => {
    expect(pathContainsSegments('/sign-in/email', '/sign-in')).toBe(true);
    expect(pathContainsSegments('/phone-number/sign-in', '/sign-in')).toBe(true);
    expect(pathContainsSegments('/oauth2/callback/google', '/callback')).toBe(true);
    expect(pathContainsSegments('/email-otp/reset-password', '/reset-password')).toBe(true);
    expect(pathContainsSegments('/sign-in-legacy', '/sign-in')).toBe(false);
    expect(pathContainsSegments('/get-session', '/session')).toBe(false);
    expect(pathContainsSegments('/sessions-export', '/session')).toBe(false);
    expect(pathContainsSegments('/sign-in/email', '')).toBe(false);
  });
});

describe('Better-Auth rate limiter on non-canonical paths', () => {
  const limiter = () => {
    const rateLimiter = new CoreBetterAuthRateLimiter();
    rateLimiter.configure({
      enabled: true,
      max: 10,
      skipEndpoints: ['/session', '/callback'],
      strictEndpoints: ['/sign-in'],
      windowSeconds: 60,
    });
    return rateLimiter;
  };

  /**
   * @regression   12.2.x — the limiter matched its skip list against the raw path: `/callback/../sign-in/email` was
   *   skipped as a callback while Better-Auth ran it as a sign-in, so sign-in attempts were not counted at all.
   * @seen-failing Decide on the raw path again in CoreBetterAuthRateLimiter.check()
   *   (src/core/modules/better-auth/core-better-auth-rate-limiter.service.ts) — registered as mutation
   *   `iam-rate-limit-reads-raw-path` in tests/regression-mutations.json.
   */
  it.each(['/callback/../sign-in/email', '/callback/%2e%2e/sign-in/email', '/session/%2E%2E/sign-in/email'])(
    'counts %s as the sign-in it runs as, with the strict limit',
    async (path) => {
      const rateLimiter = limiter();
      try {
        const result = await rateLimiter.check('192.0.2.10', path);
        expect(result.limit).toBe(5);
        expect(result.current).toBe(1);
      } finally {
        rateLimiter.onModuleDestroy();
      }
    },
  );

  /**
   * @regression   12.2.x — the limiter compared and keyed on the path as typed, while Express routes case-insensitively:
   *   every case variant of `/sign-in/email` reached the same sign-in with a counter of its own and the full limit.
   * @seen-failing Drop the lower-casing in CoreBetterAuthRateLimiter.check()
   *   (src/core/modules/better-auth/core-better-auth-rate-limiter.service.ts) — registered as mutation
   *   `iam-rate-limit-case-sensitive` in tests/regression-mutations.json.
   */
  it('counts every case variant of a sign-in on one counter with the strict limit', async () => {
    const rateLimiter = limiter();
    try {
      const first = await rateLimiter.check('192.0.2.12', '/sign-in/email');
      const second = await rateLimiter.check('192.0.2.12', '/Sign-In/EMAIL');
      expect(second.limit).toBe(5);
      expect(second.current).toBe(first.current + 1);
    } finally {
      rateLimiter.onModuleDestroy();
    }
  });

  it('still skips a real callback and the session route, and counts a sign-in strictly', async () => {
    const rateLimiter = limiter();
    try {
      expect((await rateLimiter.check('192.0.2.11', '/callback/google')).limit).toBe(Infinity);
      expect((await rateLimiter.check('192.0.2.11', '/session')).limit).toBe(Infinity);
      expect((await rateLimiter.check('192.0.2.11', '/sign-in/email')).limit).toBe(5);
      expect((await rateLimiter.check('192.0.2.11', '/two-factor/verify-totp')).limit).toBe(10);
    } finally {
      rateLimiter.onModuleDestroy();
    }
  });
});

describe('Better-Auth rate-limit middleware', () => {
  /**
   * The request as a middleware mounted by Nest on `/iam/*path` receives it: Express moves the whole match into
   * `baseUrl`, so `path` is "/" and only `originalUrl` carries the path as sent.
   */
  const mountedRequest = (originalUrl: string) => ({
    baseUrl: originalUrl.split('?')[0],
    ip: '192.0.2.20',
    originalUrl,
    path: '/',
    url: '/',
  });

  /**
   * @regression   12.2.x — the middleware read `req.path`, which is "/" under Nest's mount: every IAM request of a
   *   client shared one counter with the full limit, so the strict sign-in limit and the skip list never applied over
   *   HTTP (the limiter's own unit tests call the service directly and could not see it).
   * @seen-failing Read `req.path` again in CoreBetterAuthRateLimitMiddleware.use()
   *   (src/core/modules/better-auth/core-better-auth-rate-limit.middleware.ts) — registered as mutation
   *   `iam-rate-limit-middleware-reads-req-path` in tests/regression-mutations.json.
   */
  it('limits by the route as sent, not by the mount-relative "/"', async () => {
    const rateLimiter = new CoreBetterAuthRateLimiter();
    rateLimiter.configure({
      enabled: true,
      max: 10,
      skipEndpoints: ['/session', '/callback'],
      strictEndpoints: ['/sign-in'],
      windowSeconds: 60,
    });
    const middleware = new CoreBetterAuthRateLimitMiddleware(rateLimiter, {
      getBasePath: () => '/iam',
      isEnabled: () => true,
    } as any);
    const limitFor = async (originalUrl: string) => {
      const headers: Record<string, string> = {};
      const next = vi.fn();
      await middleware.use(
        mountedRequest(originalUrl) as any,
        { setHeader: (k: string, v: string) => (headers[k] = v) } as any,
        next,
      );
      expect(next).toHaveBeenCalledOnce();
      return headers['X-RateLimit-Limit'];
    };
    try {
      expect(await limitFor('/iam/sign-in/email?x=1')).toBe('5');
      expect(await limitFor('/iam/session')).toBe('Infinity');
      expect(await limitFor('/iam/two-factor/verify-totp')).toBe('10');
    } finally {
      rateLimiter.onModuleDestroy();
    }
  });
});
