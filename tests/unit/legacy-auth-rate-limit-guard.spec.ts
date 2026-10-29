import { ExecutionContext, HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { LegacyAuthRateLimitGuard } from '../../src/core/modules/auth/guards/legacy-auth-rate-limit.guard';
import { LegacyAuthRateLimiter } from '../../src/core/modules/auth/services/legacy-auth-rate-limiter.service';

/** An HTTP execution context for `handler`, reached through `url` from `ip`. */
function httpContext(handler: (...args: unknown[]) => unknown, url: string, ip = '1.2.3.4'): ExecutionContext {
  const request = { ip, path: url.split('?')[0], url };
  return {
    getClass: () => class CoreAuthController {},
    getHandler: () => handler,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function guardWithLimit(max: number): LegacyAuthRateLimitGuard {
  const limiter = new LegacyAuthRateLimiter();
  limiter.configure({ enabled: true, max, windowSeconds: 60 });
  return new LegacyAuthRateLimitGuard(limiter);
}

async function statusOf(guard: LegacyAuthRateLimitGuard, context: ExecutionContext): Promise<number> {
  try {
    await guard.canActivate(context);
    return 200;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : 500;
  }
}

describe('LegacyAuthRateLimitGuard', () => {
  function signIn() {}
  function signUp() {}

  /**
   * @regression   11.43.4 / 12.1.0 — the REST bucket was keyed on the last segment of `request.url`, query string
   *   included: `/auth/signin?n=1`, `?n=2`, … each got a fresh bucket, so a client guessed passwords without ever
   *   reaching the limit. Case and trailing-slash variants of the path did the same.
   * @seen-failing Key the endpoint on `request.url` again in LegacyAuthRateLimitGuard.extractRequestInfo() in
   *   src/core/modules/auth/guards/legacy-auth-rate-limit.guard.ts — registered as mutation
   *   `legacy-rate-limit-keyed-on-url` in tests/regression-mutations.json.
   */
  it('counts every spelling of one route in one bucket', async () => {
    const guard = guardWithLimit(2);
    expect(await statusOf(guard, httpContext(signIn, '/auth/signin?n=1'))).toBe(200);
    expect(await statusOf(guard, httpContext(signIn, '/auth/signin?n=2'))).toBe(200);
    expect(await statusOf(guard, httpContext(signIn, '/auth/SignIn/'))).toBe(429);
    expect(await statusOf(guard, httpContext(signIn, '/auth/signin?n=3'))).toBe(429);
  });

  it('keeps separate buckets for separate routes and separate clients', async () => {
    const guard = guardWithLimit(1);
    expect(await statusOf(guard, httpContext(signIn, '/auth/signin'))).toBe(200);
    expect(await statusOf(guard, httpContext(signIn, '/auth/signin'))).toBe(429);
    // Another route of the same client, and the same route of another client, are unaffected
    expect(await statusOf(guard, httpContext(signUp, '/auth/signup'))).toBe(200);
    expect(await statusOf(guard, httpContext(signIn, '/auth/signin', '5.6.7.8'))).toBe(200);
  });
});
