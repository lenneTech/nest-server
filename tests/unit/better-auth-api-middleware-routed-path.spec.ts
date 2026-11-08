/**
 * The API middleware decides on the path Better-Auth will ROUTE, not on the one the client wrote (12.8.1).
 *
 * `CoreBetterAuthApiMiddleware` hands every request under the IAM base path to Better-Auth's own handler, except the
 * routes `CoreBetterAuthController` serves (sign-up, sign-in, …), which carry the core's checks and every project
 * override. It compared the RAW `originalUrl` with that list, while the request it forwards is built with
 * `new URL(originalUrl, baseUrl)` — and the WHATWG URL parser resolves `.`, `..` and `%2e` segments. So
 * `/iam/sign-up/%2e/email` was "not a controller path" for the middleware and `/iam/sign-up/email` for Better-Auth:
 * its native sign-up (or sign-in) ran past the controller and the project's guards.
 *
 * `CoreBetterAuthPathGuardMiddleware` refuses such a path first (12.3.0); this pins the middleware itself, which must
 * stay right where the guard is not registered — the same rule the rate limiter follows.
 */
import { describe, expect, it, vi } from 'vitest';

import { CoreBetterAuthApiMiddleware } from '../../src/core/modules/better-auth/core-better-auth-api.middleware';

/** A middleware whose service records whether the request was taken towards Better-Auth's handler */
function middleware() {
  const getInstance = vi.fn(() => null);
  const service = {
    getBasePath: () => '/iam',
    getBaseUrl: () => 'http://localhost:3000',
    getInstance,
    isEnabled: () => true,
  };
  return { getInstance, mw: new CoreBetterAuthApiMiddleware(service as any) };
}

async function run(originalUrl: string): Promise<{ forwarded: boolean; next: boolean }> {
  const { getInstance, mw } = middleware();
  const next = vi.fn();
  await mw.use({ body: {}, headers: {}, method: 'POST', originalUrl, url: originalUrl } as any, {} as any, next);
  return { forwarded: getInstance.mock.calls.length > 0, next: next.mock.calls.length > 0 };
}

describe('CoreBetterAuthApiMiddleware: a controller route stays with the controller, whatever the URL shape', () => {
  /**
   * @regression   12.8.1 — a dot segment (`/iam/sign-up/%2e/email`) made the raw-path comparison miss the controller
   *   route, and Better-Auth's own sign-up / sign-in served it past the controller and every project override.
   * @seen-failing Compare the raw `req.originalUrl` again in CoreBetterAuthApiMiddleware.use()
   *   (src/core/modules/better-auth/core-better-auth-api.middleware.ts) — registered as mutation
   *   `api-middleware-raw-path-compared` in tests/regression-mutations.json.
   */
  it.each([
    '/iam/sign-up/%2e/email',
    '/iam/sign-up/%2E/email',
    '/iam/sign-in/%2e/email',
    '/iam/x/../sign-up/email',
    '/iam/./sign-in/email',
  ])('does not forward %s to Better-Auth', async (url) => {
    const result = await run(url);

    expect(result.forwarded).toBe(false);
    expect(result.next).toBe(true);
  });

  it('paired control: a route only Better-Auth serves is forwarded', async () => {
    expect((await run('/iam/get-session')).forwarded).toBe(true);
    // … and the plain controller route is not
    expect((await run('/iam/sign-up/email')).forwarded).toBe(false);
  });
});
