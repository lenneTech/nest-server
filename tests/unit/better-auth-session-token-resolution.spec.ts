/**
 * Unit tests: which value ends up in the session cookie, and which never may.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * 11.36.3 fixed a defect whose whole mechanism is a value confusion: with
 * `cookies.exposeTokenInBody` and the JWT plugin both active, the response body carries a JWT while
 * the session cookie must keep the OPAQUE Better-Auth session token. Better-Auth resolves a session
 * by that opaque value, so a JWT in the cookie authenticates nothing — sign-in succeeded and every
 * following request was anonymous.
 *
 * The fix rests on three small functions, and until this file none of them had a single direct
 * test. That matters more than the line count suggests: `isJwtShaped()` documents at length why it
 * is NOT `startsWith('eyJ')` alone, and a "simplification" back to that passed every test in the
 * repo while reintroducing a ~1-in-262 144 silent sign-in failure. `sessionTokenFromResponse()` is
 * a precedence chain whose session branch is, under better-auth 1.6.26, unreachable in practice —
 * so a revert to the naive ternary it replaced would go entirely unnoticed by behaviour.
 *
 * These are exactly the shapes that need pinning by CONSTRUCTION rather than by consequence.
 */
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hasToken,
  sessionTokenFromResponse,
} from '../../src/core/modules/better-auth/better-auth.types';
import { BetterAuthCookieHelper } from '../../src/core/modules/better-auth/core-better-auth-cookie.helper';
import { isJwtShaped } from '../../src/core/modules/better-auth/core-better-auth-token.helper';

/** A realistic Better-Auth session token: `generateId(32)` over `a-zA-Z0-9-_`, never a dot. */
const SESSION_TOKEN = 'nikIcyg9nohjB7LtAPYdwTkVwkUdQDGs';
const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl';

describe('isJwtShaped', () => {
  it('accepts a three-segment token beginning with eyJ', () => {
    expect(isJwtShaped(JWT)).toBe(true);
  });

  it('rejects an opaque session token', () => {
    expect(isJwtShaped(SESSION_TOKEN)).toBe(false);
  });

  /**
   * The assertion the documented rationale stands on. A Better-Auth id is generated over
   * `a-zA-Z0-9-_`, so roughly one in 262 144 begins with `eyJ` by chance — rare enough to reach
   * production as a ghost, frequent enough to happen. Requiring the DOTS removes the false positive
   * entirely, because an opaque token can never contain one.
   *
   * Without this case, replacing the implementation with `startsWith('eyJ')` passes every other
   * test in the repository and silently refuses to set a cookie for those users.
   */
  it('rejects an opaque token that merely begins with eyJ', () => {
    expect(isJwtShaped('eyJqR7tVn2LpXw8ScMbAe4Kd9FhZyQ3u')).toBe(false);
  });

  it('rejects a dotted value that does not begin with eyJ', () => {
    expect(isJwtShaped('abc.def.ghi')).toBe(false);
  });

  it('rejects segment counts other than three', () => {
    // Two segments is a signed cookie, five is a JWE. Neither is what the cookie guard asks about.
    expect(isJwtShaped('eyJhbGciOiJFZERTQSJ9.c2lnbmF0dXJl')).toBe(false);
    expect(isJwtShaped('eyJhbGciOiJFZERTQSJ9.a.b.c.d')).toBe(false);
  });

  it('rejects non-strings and the empty string rather than throwing', () => {
    // It guards a value whose provenance is unproven, so it must answer for anything.
    expect(isJwtShaped(undefined)).toBe(false);
    expect(isJwtShaped(null)).toBe(false);
    expect(isJwtShaped('')).toBe(false);
    expect(isJwtShaped(42)).toBe(false);
    expect(isJwtShaped({ token: JWT })).toBe(false);
  });
});

describe('hasToken', () => {
  it('accepts a non-empty string token', () => {
    expect(hasToken({ token: SESSION_TOKEN })).toBe(true);
  });

  /** The entire reason this guard exists rather than `'token' in response`. */
  it('rejects an empty-string token', () => {
    expect(hasToken({ token: '' })).toBe(false);
  });

  it('rejects a missing, non-string, null or undefined carrier', () => {
    expect(hasToken({})).toBe(false);
    expect(hasToken({ token: 42 })).toBe(false);
    expect(hasToken(null)).toBe(false);
    expect(hasToken(undefined)).toBe(false);
  });
});

describe('sessionTokenFromResponse', () => {
  it('prefers the token stored inside the session object', () => {
    const resolved = sessionTokenFromResponse({
      session: { expiresAt: new Date(), id: 's1', token: SESSION_TOKEN },
      token: 'top-level-value',
    });

    expect(resolved).toBe(SESSION_TOKEN);
  });

  /**
   * The branch the naive `hasSession(r) ? r.session.token : undefined` ternary gets wrong, and the
   * reason this is a chain rather than a ternary: `token` is OPTIONAL on the `hasSession()` guard,
   * so a response carrying a session object WITHOUT a token satisfies the guard, yields `undefined`
   * and never reaches the top-level fallback.
   */
  it('falls through to the top-level token when the session object carries none', () => {
    const resolved = sessionTokenFromResponse({
      session: { expiresAt: new Date(), id: 's1' },
      token: SESSION_TOKEN,
    });

    expect(resolved).toBe(SESSION_TOKEN);
  });

  /** The mirror case: `api.signInEmail()` returns the token top-level with no session object. */
  it('reads a top-level token when there is no session object at all', () => {
    expect(sessionTokenFromResponse({ token: SESSION_TOKEN })).toBe(SESSION_TOKEN);
  });

  it('treats an empty session token as absent rather than as a value', () => {
    expect(sessionTokenFromResponse({ session: { expiresAt: new Date(), id: 's1', token: '' }, token: SESSION_TOKEN })).toBe(
      SESSION_TOKEN,
    );
  });

  it('returns undefined when the response carries no token anywhere', () => {
    expect(sessionTokenFromResponse({ user: { email: 'a@test.com' } })).toBeUndefined();
    expect(sessionTokenFromResponse({})).toBeUndefined();
    expect(sessionTokenFromResponse(null)).toBeUndefined();
  });

  /**
   * Deliberately NOT filtered here. This function answers "what session token did the response
   * carry"; refusing a JWT is the COOKIE caller's concern, and the revocation callers must not
   * inherit it. Pinning the split stops a later "tidy-up" from moving the refusal down here, which
   * would silently change what the revocation paths see.
   */
  it('does not itself refuse a JWT — that is the cookie caller\'s job', () => {
    expect(sessionTokenFromResponse({ token: JWT })).toBe(JWT);
  });
});

describe('setSessionCookies refusal', () => {
  /**
   * The refusal deliberately logs through a real `Logger` when none is configured, so every test in
   * this block would otherwise write to stdout. That is not just noise: a console write racing the
   * vitest worker teardown surfaces as `Closing rpc while "onUserConsoleLog" was pending`, which
   * fails the run from a file that did nothing wrong. Capture it here instead, and let the one test
   * that cares assert on what was captured.
   */
  let logged: string[];
  let loggerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = [];
    loggerSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation((message: any) => {
      logged.push(String(message));
    });
  });

  afterEach(() => {
    loggerSpy.mockRestore();
  });

  function collectingRes() {
    const calls: Array<{ name: string; value: string }> = [];
    return {
      calls,
      res: { cookie: vi.fn((name: string, value: string) => calls.push({ name, value })) } as any,
    };
  }

  it('writes no cookie at all when handed a JWT', () => {
    const helper = new BetterAuthCookieHelper({ basePath: '/iam', secret: 'test-secret' });
    const { calls, res } = collectingRes();

    helper.setSessionCookies(res, JWT);

    expect(calls).toHaveLength(0);
  });

  it('writes the cookie when handed an opaque session token', () => {
    // The paired positive case: without it, an implementation that refuses EVERYTHING would satisfy
    // the assertion above.
    const helper = new BetterAuthCookieHelper({ basePath: '/iam', secret: 'test-secret' });
    const { calls, res } = collectingRes();

    helper.setSessionCookies(res, SESSION_TOKEN);

    expect(calls.length).toBeGreaterThan(0);
    expect(decodeURIComponent(calls.find(c => c.name === 'iam.session_token')!.value)).toContain(SESSION_TOKEN);
  });

  /**
   * The refusal is the one message in this class that must never be silent: without it the symptom
   * is "no cookie, HTTP 200, no explanation" — the same diagnostic blind spot that let the defect
   * it guards against ship. `config.logger` is OPTIONAL, so this asserts the fallback path.
   */
  it('logs the refusal even when no logger is configured', () => {
    const helper = new BetterAuthCookieHelper({ basePath: '/iam', secret: 'test-secret' });
    const { res } = collectingRes();

    helper.setSessionCookies(res, JWT);

    expect(logged.join(' ')).toContain('Refusing to write a JWT into the session cookie');
  });

  it('prefers an explicitly configured logger', () => {
    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as any;
    const helper = new BetterAuthCookieHelper({ basePath: '/iam', logger, secret: 'test-secret' });
    const { res } = collectingRes();

    helper.setSessionCookies(res, JWT);

    expect(logger.error).toHaveBeenCalledOnce();
  });
});
