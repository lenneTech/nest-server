import { describe, expect, it, vi } from 'vitest';

import { CoreBetterAuthRateLimitMiddleware } from '../../src/core/modules/better-auth/core-better-auth-rate-limit.middleware';
import { CoreBetterAuthRateLimiter } from '../../src/core/modules/better-auth/core-better-auth-rate-limiter.service';

/**
 * The IAM rate limiter keys its counters by a bounded set of names (12.8.2).
 *
 * Since 12.3.0 a counter was keyed by the last segment of the path as sent, and the middleware runs for every path
 * under the base path, existing or not. One client sending `/iam/x1`, `/iam/x2`, … therefore created one counter per
 * request; none of them reached the limit, and once the store held `maxEntries` counters every NEW client fell into the
 * shared overflow buckets the attacker had filled — and was refused at its first sign-in. Counters are now keyed by a
 * route name the base path serves, a configured strict entry, or one `other` counter per client.
 */

/** The routes of a running instance, as the middleware hands them over (a subset is enough) */
const ROUTES = ['/sign-in/email', '/sign-up/email', '/get-session', '/two-factor/enable', '/reset-password/:token'];

function limiter(config: Record<string, unknown> = {}): CoreBetterAuthRateLimiter {
  const rateLimiter = new CoreBetterAuthRateLimiter();
  rateLimiter.configure({ max: 10, windowSeconds: 60, ...config });
  rateLimiter.setKnownEndpoints(ROUTES);
  return rateLimiter;
}

describe('CoreBetterAuthRateLimiter: bounded counter keys', () => {
  /**
   * @regression   12.8.2 — paths nobody serves created one counter each, so one client filled the store and every new
   *   client was refused at its first sign-in.
   * @seen-failing Return the raw last segment again in normalizeEndpoint()
   *   (src/core/modules/better-auth/core-better-auth-rate-limiter.service.ts) — registered as mutation
   *   `iam-rate-limit-key-unbounded` in tests/regression-mutations.json.
   */
  it('counts unknown paths of one client in one counter, which reaches the limit', async () => {
    const rateLimiter = limiter();
    const results = [];
    for (let i = 0; i < 20; i++) {
      results.push(await rateLimiter.check('203.0.113.7', `/x${i}`));
    }

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results[results.length - 1].allowed).toBe(false);
  });

  /**
   * @regression   12.8.2 — the consequence that made it a lockout: a full store refused every new client.
   * @seen-failing Same mutation `iam-rate-limit-key-unbounded`.
   */
  it('lets new clients sign in after one client sent thousands of unknown paths', async () => {
    const rateLimiter = limiter({ maxEntries: 100 });
    for (let i = 0; i < 2000; i++) {
      await rateLimiter.check('203.0.113.7', `/probe-${i}`);
    }

    for (let client = 1; client <= 20; client++) {
      expect((await rateLimiter.check(`198.51.100.${client}`, '/sign-in/email')).allowed, `client ${client}`).toBe(
        true,
      );
    }
  });

  it('keeps a strict route under an unknown name on its own strict counter', async () => {
    const rateLimiter = limiter();
    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(await rateLimiter.check('203.0.113.8', `/reset-password/token-${i}`));
    }

    // Half of max, shared by every token: the strict limit still applies, and the tokens make no counters
    expect(results.map((result) => result.limit)).toEqual(Array(8).fill(5));
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
  });

  it('paired control: real routes keep their counter per route name', async () => {
    const rateLimiter = limiter();

    // sign-in and sign-up share `email`, as since 12.3.0: five strict attempts for both together
    for (let i = 0; i < 3; i++) {
      await rateLimiter.check('203.0.113.9', '/sign-in/email');
    }
    expect((await rateLimiter.check('203.0.113.9', '/sign-up/email')).current).toBe(4);

    // a route with a name of its own does not use up the budget of another
    for (let i = 0; i < 10; i++) {
      await rateLimiter.check('203.0.113.9', '/get-session');
    }
    expect((await rateLimiter.check('203.0.113.9', '/two-factor/enable')).allowed).toBe(true);
  });

  it('stays bounded before the routes are known', async () => {
    const rateLimiter = new CoreBetterAuthRateLimiter();
    rateLimiter.configure({ max: 10, windowSeconds: 60 });
    const results = [];
    for (let i = 0; i < 20; i++) {
      results.push(await rateLimiter.check('203.0.113.10', `/y${i}`));
    }

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
  });
});

describe('CoreBetterAuthRateLimitMiddleware: route names from the running instance', () => {
  /**
   * @regression   12.8.2 — the limiter knows route names only through the middleware; without them every real route
   *   of a client would share one counter.
   * @seen-failing Drop the `this.provideKnownEndpoints()` call in CoreBetterAuthRateLimitMiddleware.use()
   *   (src/core/modules/better-auth/core-better-auth-rate-limit.middleware.ts) — registered as mutation
   *   `iam-rate-limit-known-routes-not-provided` in tests/regression-mutations.json.
   */
  it("keys counters by the instance's routes", async () => {
    const rateLimiter = new CoreBetterAuthRateLimiter();
    rateLimiter.configure({ max: 10, windowSeconds: 60 });
    const instance = { api: { getSession: { path: '/get-session' }, enable: { path: '/two-factor/enable' } } };
    const middleware = new CoreBetterAuthRateLimitMiddleware(rateLimiter, {
      getBasePath: () => '/iam',
      getInstance: () => instance,
      isEnabled: () => true,
    } as any);
    const send = async (originalUrl: string): Promise<boolean> => {
      const next = vi.fn();
      try {
        await middleware.use(
          { ip: '203.0.113.11', originalUrl, url: originalUrl } as any,
          { setHeader: () => undefined } as any,
          next,
        );
      } catch {
        return false;
      }
      return next.mock.calls.length === 1;
    };
    try {
      for (let i = 0; i < 10; i++) {
        expect(await send('/iam/get-session')).toBe(true);
      }
      // `enable` has a counter of its own, so the session polling above did not use up its budget
      expect(await send('/iam/two-factor/enable')).toBe(true);
    } finally {
      rateLimiter.onModuleDestroy();
    }
  });
});
