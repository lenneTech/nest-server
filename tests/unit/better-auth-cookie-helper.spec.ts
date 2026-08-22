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

  /**
   * The session cookie and the body token are two different things.
   *
   * With `cookies` AND `exposeTokenInBody` both on, the sign-in path converts
   * the session token into a JWT for the response body — that is what a
   * bearer-using client wants. The cookie must NOT get that JWT: BetterAuth
   * looks a session up by the opaque token it stored, and a JWT is not it. The
   * result was a request that authenticated once and was anonymous ever after
   * — `/iam/session` answered `success: false` on a session that plainly
   * existed in the database.
   *
   * So the cookie takes the session token explicitly, and the body keeps the
   * JWT.
   */
  /**
   * @regression   11.36.2 — `processAuthResult()` wrote the body's JWT into the session cookie when
   *   both delivery modes were active, so Better-Auth could not resolve the session it had just
   *   created.
   * @seen-failing Replace `const cookieToken = sessionToken ?? result.token;` with
   *   `const cookieToken = result.token;` in
   *   `src/core/modules/better-auth/core-better-auth-cookie.helper.ts` — registered as mutation
   *   `session-cookie-must-not-carry-body-jwt` in `tests/regression-mutations.json`.
   */
  // Scope, so nobody reads these four cases as proof the BUG is fixed: they pin the HELPER's
  // contract. The controller returns early before reaching the helper on the sign-in path, so the
  // fix itself is pinned one level up, by the hybrid-mode case in
  // tests/stories/cookies-security-property.e2e-spec.ts. Both are needed.
  // (Line comment on purpose: the evidence guard requires every mutation id inside a block comment
  // to run the file the block lives in.)
  describe('session cookie vs. body token', () => {
    const SESSION_TOKEN = 'nikIcyg9nohjB7LtAPYdwTkVwkUdQDGs';
    const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl';

    function collectingRes() {
      const calls: Array<{ name: string; value: string }> = [];
      return {
        calls,
        res: { cookie: vi.fn((name: string, value: string) => calls.push({ name, value })) } as any,
      };
    }

    it('writes the SESSION token into the cookie when one is handed over', () => {
      const helper = new BetterAuthCookieHelper(createConfig({ secret: 'test-secret' }));
      const { calls, res } = collectingRes();

      const result = helper.processAuthResult(res, { token: JWT }, true, true, SESSION_TOKEN);

      const sessionCookie = calls.find((c) => c.name === 'iam.session_token');
      expect(sessionCookie).toBeDefined();
      // Signed, so the value carries the token plus a signature — the token
      // itself has to be in there, and the JWT must not.
      expect(decodeURIComponent(sessionCookie!.value)).toContain(SESSION_TOKEN);
      expect(sessionCookie!.value).not.toContain('eyJhbGciOiJFZERTQSJ9');

      // …and the body still carries the JWT for bearer-using clients.
      expect(result.token).toBe(JWT);
    });

    it('never lets a JWT reach the session cookie', () => {
      // The regression this whole block exists for: a JWT in the session
      // cookie authenticates the sign-in response and nothing afterwards.
      const helper = new BetterAuthCookieHelper(createConfig({ secret: 'test-secret' }));
      const { calls, res } = collectingRes();

      helper.processAuthResult(res, { token: JWT }, true, true, SESSION_TOKEN);

      // Load-bearing, and the reason this test was vacuous before: under the registered mutation
      // `setSessionCookies()` REFUSES the JWT and writes nothing, so `calls` is empty and the loop
      // below iterates zero times — passing with the defect fully restored. Assert that cookies
      // were written at all before asserting anything about their contents.
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        expect(call.value.startsWith('eyJ')).toBe(false);
      }
    });

    it('falls back to the body token when no session token is handed over', () => {
      const helper = new BetterAuthCookieHelper(createConfig({ secret: 'test-secret' }));
      const { calls, res } = collectingRes();

      helper.processAuthResult(res, { token: SESSION_TOKEN }, true, true);

      const sessionCookie = calls.find((c) => c.name === 'iam.session_token');
      expect(decodeURIComponent(sessionCookie!.value)).toContain(SESSION_TOKEN);
    });

    it('still removes the body token in cookies-only mode', () => {
      const helper = new BetterAuthCookieHelper(createConfig({ secret: 'test-secret' }));
      const { calls, res } = collectingRes();

      const result = helper.processAuthResult(res, { token: SESSION_TOKEN }, true, false, SESSION_TOKEN);

      expect(result.token).toBeUndefined();
      expect(decodeURIComponent(calls.find((c) => c.name === 'iam.session_token')!.value)).toContain(
        SESSION_TOKEN,
      );
    });
  });
});

/**
 * Structural invariant, in the style of `import-cycle-invariants.spec.ts`.
 *
 * `processAuthResult()` is public API on an exported class, and `processCookies()` is a documented
 * inheritance seam. TypeScript permits an override with FEWER parameters, so a subclass that still
 * declares the pre-11.36.2 four-argument signature keeps compiling while silently dropping the
 * session token — reintroducing the defect in a consumer project with no compile error.
 *
 * Two things answer that. `setSessionCookies()` refuses a JWT-shaped value outright, so the failure
 * is loud (no cookie, an error log) rather than silent (the wrong cookie). And this test pins the
 * arity, so the parameter cannot quietly disappear from the framework side either.
 *
 * The cleaner fix is an options object, which would turn a short override into a compile error —
 * but that is a breaking change to a shipped public signature and belongs in a MINOR release, not
 * in a patch that projects need urgently.
 */
describe('processAuthResult signature (structural invariant)', () => {
  it('still accepts the session token as its fifth parameter', () => {
    // `Function.length` counts parameters before the first default, so `exposeTokenInBody = false`
    // truncates it at 3. Read the source instead — this is about the declared shape, not arity.
    //
    // Only the PARAMETER LIST, not the whole function: `sessionToken` also appears in the body
    // (`const cookieToken = sessionToken ?? result.token`), so matching the full source would keep
    // passing after the parameter was removed — the one change this test exists to catch.
    const source = BetterAuthCookieHelper.prototype.processAuthResult.toString();
    const signature = source.slice(0, source.indexOf('{'));

    expect(signature, 'processAuthResult must still declare a sessionToken parameter').toContain('sessionToken');
  });

  it('prefers the session token over the body token when both are present', () => {
    // The behavioural half of the same invariant: the parameter existing is worthless if the body
    // token wins. Fails the moment the precedence is inverted.
    const sessionToken = 'nikIcyg9nohjB7LtAPYdwTkVwkUdQDGs';
    const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl';
    const written: Array<{ name: string; value: string }> = [];
    const res = { cookie: vi.fn((name: string, value: string) => written.push({ name, value })) } as any;
    const helper = new BetterAuthCookieHelper({ basePath: '/iam', secret: 'test-secret' });

    helper.processAuthResult(res, { token: jwt }, true, true, sessionToken);

    expect(written.length).toBeGreaterThan(0);
    for (const cookie of written) {
      expect(decodeURIComponent(cookie.value).startsWith('eyJ'), `${cookie.name} must not carry the JWT`).toBe(false);
    }
  });
});
