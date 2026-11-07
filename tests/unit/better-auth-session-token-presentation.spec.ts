/**
 * The session token in responses Better-Auth produces itself (12.6.1).
 *
 * The framework's own sign-in keeps the opaque session token out of the body in the default cookie mode (httpOnly
 * cookie only) and hands out a JWT where the body may carry a token (SEC-005). Routes the framework forwards to
 * Better-Auth's handler — two-factor verify-totp / verify-backup-code / verify-otp, passkey verify, OTP and
 * magic-link sign-in, get-session — bypassed both: `{ token: <session token>, user }` reached the client, and a
 * frontend stored the 7-day session token where any script could read it. These cases pin the policy
 * (`presentSessionTokens()`), its wiring (`CoreBetterAuthService.sendBetterAuthResponse()`), and that the two places
 * that forward to Better-Auth send through it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreBetterAuthApiMiddleware } from '../../src/core/modules/better-auth/core-better-auth-api.middleware';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';
import {
  presentSessionTokens,
  sessionTokenFromSetCookie,
} from '../../src/core/modules/better-auth/core-better-auth-session-token.helper';

const COOKIE = 'iam.session_token';
const SECURE_COOKIE = '__Secure-iam.session_token';
const SESSION_TOKEN = 'Xq3vS9kLm2Pz8RtYw4Bn6Cd1Fg5Hj7Ka';
const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const USER = { email: 'two.factor@test.com', id: 'u1' };

/** A JSON response as Better-Auth's handler answers, optionally setting the session cookie */
function betterAuthResponse(
  body: unknown,
  options: { cookieName?: string; setsSession?: boolean; status?: number } = {},
): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.setsSession) {
    headers.append(
      'set-cookie',
      `${options.cookieName ?? COOKIE}=${encodeURIComponent(`${SESSION_TOKEN}.c2lnbmF0dXJl`)}; Path=/; HttpOnly`,
    );
  }
  headers.append('set-cookie', 'iam.dont_remember=; Max-Age=0; Path=/');
  return new Response(JSON.stringify(body), { headers, status: options.status ?? 200 });
}

/** The policy as the service builds it; SESSION_TOKEN is the one live session */
function policy(tokenInBody: boolean, resolveJwt = vi.fn(async (_token: string) => JWT)) {
  const isSessionToken = vi.fn(async (token: string) => token === SESSION_TOKEN);
  return { isSessionToken, options: { cookieName: COOKIE, isSessionToken, resolveJwt, tokenInBody }, resolveJwt };
}

describe('presentSessionTokens()', () => {
  describe('cookie mode (the default): the session token never reaches the body', () => {
    /**
     * @regression   12.6.1 — two-factor verify-totp / verify-backup-code / verify-otp are forwarded to Better-Auth and
     *   answered `{ token: <session token>, user }`, so the opaque session token reached the client in cookie mode,
     *   where it must exist as an httpOnly cookie only; a frontend wrote it into a script-readable cookie.
     * @seen-failing Keep the session token in the body in cookie mode in presentSessionTokens() in
     *   src/core/modules/better-auth/core-better-auth-session-token.helper.ts — registered as mutation
     *   `session-token-kept-in-cookie-mode` in tests/regression-mutations.json.
     */
    it('drops the session token of a second factor, keeps the user and every cookie', async () => {
      const { options, resolveJwt } = policy(false);
      const presented = await presentSessionTokens(
        betterAuthResponse({ token: SESSION_TOKEN, user: USER }, { setsSession: true }),
        options,
      );

      expect(await presented.json()).toEqual({ user: USER });
      expect(presented.headers.getSetCookie()).toHaveLength(2);
      expect(sessionTokenFromSetCookie(presented, COOKIE)).toBe(SESSION_TOKEN);
      expect(resolveJwt).not.toHaveBeenCalled();
    });

    /**
     * @regression   12.6.1 — passkey verify and get-session carry the session token as `session.token`, which reached
     *   scripts in cookie mode the same way.
     * @seen-failing Keep `session.token` in presentSessionTokens() in
     *   src/core/modules/better-auth/core-better-auth-session-token.helper.ts — registered as mutation
     *   `session-field-token-kept` in tests/regression-mutations.json.
     */
    it('drops session.token of a passkey verification and of get-session', async () => {
      const { options } = policy(false);
      const passkey = await presentSessionTokens(
        betterAuthResponse({ session: { id: 's1', token: SESSION_TOKEN, userId: 'u1' } }, { setsSession: true }),
        options,
      );
      const getSession = await presentSessionTokens(
        betterAuthResponse({ session: { id: 's1', token: SESSION_TOKEN }, user: USER }),
        options,
      );

      expect(await passkey.json()).toEqual({ session: { id: 's1', userId: 'u1' } });
      expect(await getSession.json()).toEqual({ session: { id: 's1' }, user: USER });
    });

    /**
     * @regression   12.6.1 review — a SIGNED-IN user verifying a second factor (step-up, adding an authenticator next to
     *   e-mail OTP) gets `{ token: <the session they hold>, user }` with NO session cookie, so neither the cookie nor
     *   `session.token` identified it and the live session token reached the body again.
     * @seen-failing Recognise the session token by cookie and `session.token` only in presentSessionTokens() in
     *   src/core/modules/better-auth/core-better-auth-session-token.helper.ts — registered as mutation
     *   `session-token-without-cookie-kept` in tests/regression-mutations.json.
     */
    it('drops the token of the session a signed-in user already holds, which a second factor returns without a cookie', async () => {
      const { isSessionToken, options } = policy(false);
      const presented = await presentSessionTokens(betterAuthResponse({ token: SESSION_TOKEN, user: USER }), options);

      expect(await presented.json()).toEqual({ user: USER });
      expect(isSessionToken).toHaveBeenCalledWith(SESSION_TOKEN);
    });

    it('asks the session store only when the response does not already name the session token', async () => {
      const { isSessionToken, options } = policy(false);
      await presentSessionTokens(
        betterAuthResponse({ token: SESSION_TOKEN, user: USER }, { setsSession: true }),
        options,
      );
      await presentSessionTokens(betterAuthResponse({ token: JWT }), options);

      expect(isSessionToken).not.toHaveBeenCalled();
    });
  });

  describe('token in the body (cookies disabled or exposeTokenInBody): a JWT, as sign-in hands out', () => {
    /**
     * @regression   12.6.1 — where the body may carry a token, sign-in hands out a JWT (SEC-005); the forwarded second
     *   factor handed out the raw session token instead.
     * @seen-failing Put the session token itself into the body in presentSessionTokens() in
     *   src/core/modules/better-auth/core-better-auth-session-token.helper.ts — registered as mutation
     *   `session-token-not-converted-to-jwt` in tests/regression-mutations.json.
     */
    it('turns the session token of a second factor into the JWT', async () => {
      const { options, resolveJwt } = policy(true);
      const presented = await presentSessionTokens(
        betterAuthResponse({ token: SESSION_TOKEN, user: USER }, { setsSession: true }),
        options,
      );

      expect(await presented.json()).toEqual({ token: JWT, user: USER });
      expect(resolveJwt).toHaveBeenCalledWith(SESSION_TOKEN);
    });

    it('turns the token of a signed-in user’s second factor, which sets no cookie, into the JWT', async () => {
      const { options } = policy(true);
      const presented = await presentSessionTokens(betterAuthResponse({ token: SESSION_TOKEN, user: USER }), options);

      expect(await presented.json()).toEqual({ token: JWT, user: USER });
    });

    it('gives a passkey verification, which answers { session } only, the JWT of the session it created', async () => {
      const { options } = policy(true);
      const presented = await presentSessionTokens(
        betterAuthResponse({ session: { id: 's1', token: SESSION_TOKEN } }, { setsSession: true }),
        options,
      );

      expect(await presented.json()).toEqual({ session: { id: 's1' }, token: JWT });
    });

    it('drops session.token of get-session without converting anything', async () => {
      const { options, resolveJwt } = policy(true);
      const presented = await presentSessionTokens(
        betterAuthResponse({ session: { id: 's1', token: SESSION_TOKEN }, user: USER }),
        options,
      );

      expect(await presented.json()).toEqual({ session: { id: 's1' }, user: USER });
      expect(resolveJwt).not.toHaveBeenCalled();
    });

    it('drops the token when the conversion fails, rather than hand out the session token', async () => {
      const { options } = policy(
        true,
        vi.fn(async () => undefined),
      );
      const presented = await presentSessionTokens(
        betterAuthResponse({ token: SESSION_TOKEN, user: USER }, { setsSession: true }),
        options,
      );

      expect(await presented.json()).toEqual({ user: USER });
    });
  });

  describe('left alone', () => {
    it.each([
      ['a JWT that /token hands out on purpose', betterAuthResponse({ token: JWT })],
      ['another plugin’s token that is no session token', betterAuthResponse({ token: 'one-time-1234567890' })],
      ['an error response', betterAuthResponse({ token: SESSION_TOKEN }, { setsSession: true, status: 401 })],
      ['a list without session records', betterAuthResponse([{ token: 'one-time-1234567890' }, 'x'])],
      ['a body without any token', betterAuthResponse({ status: true })],
    ])('%s', async (_case, response) => {
      const { options } = policy(false);

      expect(await presentSessionTokens(response, options)).toBe(response);
    });

    it('a token the session store cannot vouch for, because the lookup failed', async () => {
      const response = betterAuthResponse({ token: SESSION_TOKEN, user: USER });
      const { options } = policy(false);
      options.isSessionToken = vi.fn(async () => {
        throw new Error('store unavailable');
      });

      expect(await presentSessionTokens(response, options)).toBe(response);
    });

    it('a response that is no JSON', async () => {
      const response = new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      const { options } = policy(false);

      expect(await presentSessionTokens(response, options)).toBe(response);
    });
  });
});

describe('a response that rotated the session (12.7.1, DEV-4129)', () => {
  const OLD_SESSION_TOKEN = 'Old0Session0Token0Deleted0By0Enable';

  /**
   * @regression   12.7.1 (DEV-4129) — the first verify-totp while enabling 2FA creates a new session, sets its cookie,
   *   deletes the old one and answers with the OLD token. Neither the cookie nor the session store recognised it, so
   *   the token of the replaced session still reached the body.
   * @seen-failing Never treat a token next to a newly set session cookie as rotated in presentSessionTokens() in
   *   src/core/modules/better-auth/core-better-auth-session-token.helper.ts — registered as mutation
   *   `rotated-session-token-kept` in tests/regression-mutations.json.
   */
  it('drops the token of the replaced session in cookie mode', async () => {
    const { options } = policy(false);
    const presented = await presentSessionTokens(
      betterAuthResponse({ token: OLD_SESSION_TOKEN, user: USER }, { setsSession: true }),
      options,
    );

    expect(await presented.json()).toEqual({ user: USER });
    expect(sessionTokenFromSetCookie(presented, COOKIE)).toBe(SESSION_TOKEN);
  });

  it('presents the JWT of the NEW session where the body carries a token', async () => {
    const { options, resolveJwt } = policy(true);
    const presented = await presentSessionTokens(
      betterAuthResponse({ token: OLD_SESSION_TOKEN, user: USER }, { setsSession: true }),
      options,
    );

    expect(await presented.json()).toEqual({ token: JWT, user: USER });
    expect(resolveJwt).toHaveBeenCalledWith(SESSION_TOKEN);
    expect(resolveJwt).not.toHaveBeenCalledWith(OLD_SESSION_TOKEN);
  });

  /** A rotation during which the session was due for a refresh: the refreshed OLD cookie first, the new one after it */
  function rotatedAfterRefresh(): Response {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', `${COOKIE}=${encodeURIComponent(`${OLD_SESSION_TOKEN}.c2lnbmF0dXJl`)}; Path=/`);
    headers.append('set-cookie', `${COOKIE}=${encodeURIComponent(`${SESSION_TOKEN}.c2lnbmF0dXJl`)}; Path=/`);
    return new Response(JSON.stringify({ token: OLD_SESSION_TOKEN, user: USER }), { headers, status: 200 });
  }

  /**
   * @regression   12.7.1 review — Better-Auth's verify-totp reads the session through getSessionFromCtx(), which sets the
   *   refreshed cookie of the CURRENT session once per updateAge. Enabling 2FA then sets the new session's cookie
   *   after it, and the browser keeps the last one; the helper read the first, missed the rotation and, with the
   *   token in the body, tried the deleted session and handed out no token at all.
   * @seen-failing Return the FIRST session cookie in sessionTokenFromSetCookie() in
   *   src/core/modules/better-auth/core-better-auth-session-token.helper.ts — registered as mutation
   *   `session-cookie-first-of-several-read` in tests/regression-mutations.json.
   */
  it('reads the session cookie the browser keeps when a refresh set the old one first', async () => {
    expect(sessionTokenFromSetCookie(rotatedAfterRefresh(), COOKIE)).toBe(SESSION_TOKEN);

    const { options, resolveJwt } = policy(true);
    const presented = await presentSessionTokens(rotatedAfterRefresh(), options);

    expect(await presented.json()).toEqual({ token: JWT, user: USER });
    expect(resolveJwt).toHaveBeenCalledWith(SESSION_TOKEN);
    expect(resolveJwt).not.toHaveBeenCalledWith(OLD_SESSION_TOKEN);
  });

  /**
   * @regression   12.7.1 review — a session refresh sets the session cookie on ANY session-protected request, so a
   *   plugin's own token can sit next to it: `/one-time-token/generate` answers `{ token }`. Read as a rotation, the
   *   one-time token was dropped in cookie mode and replaced by the session JWT with the token in the body.
   * @seen-failing Treat every opaque token next to another session cookie as rotated, without the `{ token, user }`
   *   shape, in presentSessionTokens() in src/core/modules/better-auth/core-better-auth-session-token.helper.ts —
   *   registered as mutation `plugin-token-read-as-rotation` in tests/regression-mutations.json.
   */
  it.each([
    ['cookie mode', false],
    ['token in body', true],
  ])("keeps a plugin's own token next to a refreshed session cookie in %s", async (_mode, tokenInBody) => {
    const ONE_TIME_TOKEN = 'One0Time0Token0For0A0Handoff0abcd';
    const { options, resolveJwt } = policy(tokenInBody);
    const presented = await presentSessionTokens(
      betterAuthResponse({ token: ONE_TIME_TOKEN }, { setsSession: true }),
      options,
    );

    expect(await presented.json()).toEqual({ token: ONE_TIME_TOKEN });
    expect(resolveJwt).not.toHaveBeenCalled();
  });
});

describe('session records (list-sessions), 12.7.0', () => {
  const SESSIONS = [
    { expiresAt: '2026-11-13T00:00:00.000Z', id: 's1', token: SESSION_TOKEN, userId: 'u1' },
    { expiresAt: '2026-11-13T00:00:00.000Z', id: 's2', token: 'Other0Session0Token0Of0The0User0', userId: 'u1' },
  ];

  /**
   * @regression   12.7.0 (DEV-4109) — `list-sessions` answered every session of the user with its token, so any script
   *   on the page could read the bearer credential of every device the user is signed in on.
   * @seen-failing Leave arrays untouched in presentSessionTokens() in
   *   src/core/modules/better-auth/core-better-auth-session-token.helper.ts — registered as mutation
   *   `session-list-tokens-kept` in tests/regression-mutations.json.
   */
  it.each([
    ['cookie mode', false],
    ['token in body', true],
  ])('drops the token of every listed session in %s and keeps the id', async (_mode, tokenInBody) => {
    const { options, resolveJwt } = policy(tokenInBody);
    const presented = await presentSessionTokens(betterAuthResponse(SESSIONS), options);

    expect(await presented.json()).toEqual([
      { expiresAt: '2026-11-13T00:00:00.000Z', id: 's1', userId: 'u1' },
      { expiresAt: '2026-11-13T00:00:00.000Z', id: 's2', userId: 'u1' },
    ]);
    expect(resolveJwt).not.toHaveBeenCalled();
  });

  it('drops the token of a body that is itself a session record', async () => {
    const { options } = policy(false);
    const presented = await presentSessionTokens(betterAuthResponse(SESSIONS[0]), options);

    expect(await presented.json()).toEqual({ expiresAt: '2026-11-13T00:00:00.000Z', id: 's1', userId: 'u1' });
  });
});

describe('revoke-session by id (DEV-4109)', () => {
  function middleware(
    sessionTokenOfUser = vi.fn(async (_userId: string, id: string) => (id === 's2' ? 'tok-2' : undefined)),
  ) {
    const service = { sessionTokenOfUser };
    return { mw: new CoreBetterAuthApiMiddleware(service as any) as any, sessionTokenOfUser };
  }
  const request = (body: unknown, method = 'POST') =>
    ({ betterAuthSession: { user: { id: 'u1' } }, body, method }) as any;

  /**
   * @regression   12.7.0 (DEV-4109) — once list-sessions hands out ids only, a client can revoke a session only by its
   *   id; Better-Auth's route takes a token, so the middleware must resolve the id among the caller's own sessions.
   * @seen-failing Leave the body unchanged in resolveRevokeSessionId() in
   *   src/core/modules/better-auth/core-better-auth-api.middleware.ts — registered as mutation
   *   `revoke-session-id-not-resolved` in tests/regression-mutations.json.
   */
  it('turns { sessionId } into the token of that session of the signed-in user', async () => {
    const { mw, sessionTokenOfUser } = middleware();
    const req = request({ sessionId: 's2' });
    await mw.resolveRevokeSessionId(req, '/revoke-session');

    expect(req.body).toEqual({ token: 'tok-2' });
    expect(sessionTokenOfUser).toHaveBeenCalledWith('u1', 's2');
  });

  /**
   * @regression   12.7.2 (DEV-4133) — the caller was looked up by `user.id`, which the session lookup takes from a
   *   STORED `id` first; the legacy migration writes one of its own next to `_id`, while every session references
   *   `_id`. For a migrated user no session was found, and revoke-session by id ended nothing.
   * @seen-failing Read only `betterAuthSession.user.id` in resolveRevokeSessionId() in
   *   src/core/modules/better-auth/core-better-auth-api.middleware.ts — registered as mutation
   *   `revoke-session-id-by-stored-user-id` in tests/regression-mutations.json.
   */
  it("looks the session up under the session's userId when the user carries a stored id of its own", async () => {
    const { mw, sessionTokenOfUser } = middleware();
    const req = {
      betterAuthSession: { session: { userId: '64f0c0ffee0c0ffee0c0ffee' }, user: { id: 'migrated-string-id' } },
      betterAuthUser: { id: 'migrated-string-id' },
      body: { sessionId: 's2' },
      method: 'POST',
    } as any;
    await mw.resolveRevokeSessionId(req, '/revoke-session');

    expect(req.body).toEqual({ token: 'tok-2' });
    expect(sessionTokenOfUser).toHaveBeenCalledWith('64f0c0ffee0c0ffee0c0ffee', 's2');
    expect(sessionTokenOfUser).not.toHaveBeenCalledWith('migrated-string-id', 's2');
  });

  it('turns an id it cannot resolve into an empty token, so Better-Auth revokes nothing', async () => {
    const { mw } = middleware();
    const req = request({ sessionId: 's-of-someone-else' });
    await mw.resolveRevokeSessionId(req, '/revoke-session');

    expect(req.body).toEqual({ token: '' });
  });

  it('leaves a body with a token, another route and another method alone', async () => {
    const { mw, sessionTokenOfUser } = middleware();
    const withToken = request({ sessionId: 's2', token: 'given' });
    const otherRoute = request({ sessionId: 's2' });
    const get = request({ sessionId: 's2' }, 'GET');
    await mw.resolveRevokeSessionId(withToken, '/revoke-session');
    await mw.resolveRevokeSessionId(otherRoute, '/revoke-sessions');
    await mw.resolveRevokeSessionId(get, '/revoke-session');

    expect(withToken.body).toEqual({ sessionId: 's2', token: 'given' });
    expect(otherRoute.body).toEqual({ sessionId: 's2' });
    expect(get.body).toEqual({ sessionId: 's2' });
    expect(sessionTokenOfUser).not.toHaveBeenCalled();
  });

  /**
   * @regression   12.7.0 (DEV-4109) — the id lookup must stay inside the caller's own sessions, or a session id would
   *   be enough to end another user's session.
   * @seen-failing Drop the owner comparison in sessionTokenOfUser() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
   *   `session-id-of-other-user-resolved` in tests/regression-mutations.json.
   */
  it('resolves only sessions of the given user', async () => {
    const sessions = [
      { id: 's1', token: 'tok-1', userId: 'u1' },
      { id: 's9', token: 'tok-9', userId: 'u9' },
    ];
    const service = {
      getInstance: () => ({
        $context: Promise.resolve({ internalAdapter: { listSessions: vi.fn(async () => sessions) } }),
      }),
      logger: { debug: vi.fn() },
    };
    const lookup = (userId: string, id: string) =>
      CoreBetterAuthService.prototype.sessionTokenOfUser.call(service as any, userId, id);

    expect(await lookup('u1', 's1')).toBe('tok-1');
    expect(await lookup('u1', 's9')).toBeUndefined();
    expect(await lookup('u1', 'unknown')).toBeUndefined();
  });

  /**
   * @regression   12.7.1 (DEV-4109 review) — the lookup listed ALL session rows of the user. Better-Auth's adapter caps
   *   that at 100 rows, oldest first, and MongoDB never removes an expired session row: a user with 100 old rows could
   *   no longer end a current session by id (Better-Auth answered 200, the session stayed valid).
   * @seen-failing List sessions without `onlyActiveSessions` in sessionTokenOfUser() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
   *   `session-lookup-includes-expired-rows` in tests/regression-mutations.json.
   */
  it('looks the id up among the ACTIVE sessions — the list list-sessions shows', async () => {
    const listSessions = vi.fn(async () => [{ id: 's1', token: 'tok-1', userId: 'u1' }]);
    const service = {
      getInstance: () => ({ $context: Promise.resolve({ internalAdapter: { listSessions } }) }),
      logger: { debug: vi.fn() },
    };

    await CoreBetterAuthService.prototype.sessionTokenOfUser.call(service as any, 'u1', 's1');

    expect(listSessions).toHaveBeenCalledWith('u1', { onlyActiveSessions: true });
  });
});

describe('CoreBetterAuthService.sendBetterAuthResponse()', () => {
  const previous = ConfigService.configFastButReadOnly;
  afterEach(() => ConfigService.setConfig((previous ?? {}) as any, { reInit: true, warn: false }));

  /** The Express response the forwarding writes to, recording what reaches the client */
  function expressResponse() {
    const chunks: Uint8Array[] = [];
    const headers: Record<string, unknown> = {};
    const res = {
      end: vi.fn(),
      getHeader: (key: string) => headers[key.toLowerCase()],
      setHeader: (key: string, value: unknown) => {
        headers[key.toLowerCase()] = value;
      },
      status: vi.fn(),
      write: (chunk: Uint8Array) => {
        chunks.push(chunk);
      },
    };
    const body = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { body, headers, res };
  }

  /** The service's own policy methods on a stand-in instance whose session cookie is `cookieName` */
  function service(cookieName = COOKIE) {
    return {
      getInstance: () => ({ $context: Promise.resolve({ authCookies: { sessionToken: { name: cookieName } } }) }),
      getSessionByToken: vi.fn(async (token: string) => ({
        session: token === SESSION_TOKEN ? { id: 's1', token, userId: 'u1' } : null,
        user: null,
      })),
      getSessionCookieName: () => COOKIE,
      presentSessionTokens: CoreBetterAuthService.prototype.presentSessionTokens,
      resolveJwtToken: vi.fn(async (token: string) => (token === SESSION_TOKEN ? JWT : token)),
      sessionCookieNameOfInstance: (CoreBetterAuthService.prototype as any).sessionCookieNameOfInstance,
    };
  }

  /**
   * @regression   12.6.1 — the forwarding sent Better-Auth's response unchanged; the policy must sit on the path every
   *   forwarded route takes.
   * @seen-failing Send Better-Auth's response without presentSessionTokens() in sendBetterAuthResponse() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
   *   `forwarded-session-token-not-presented` in tests/regression-mutations.json.
   */
  it('sends a second factor without the session token in cookie mode', async () => {
    ConfigService.setConfig({ ...(previous as object), cookies: true } as any, { reInit: true, warn: false });
    const { body, headers, res } = expressResponse();

    await CoreBetterAuthService.prototype.sendBetterAuthResponse.call(
      service(),
      res as any,
      betterAuthResponse({ token: SESSION_TOKEN, user: USER }, { setsSession: true }),
    );

    expect(body()).toEqual({ user: USER });
    expect(String(headers['set-cookie'])).toContain(`${COOKIE}=`);
  });

  it.each([
    ['cookies disabled (JWT-only mode)', false],
    ['exposeTokenInBody', { exposeTokenInBody: true }],
  ])('sends a second factor with the JWT when %s', async (_mode, cookies) => {
    ConfigService.setConfig({ ...(previous as object), cookies } as any, { reInit: true, warn: false });
    const { body, res } = expressResponse();

    await CoreBetterAuthService.prototype.sendBetterAuthResponse.call(
      service(),
      res as any,
      betterAuthResponse({ token: SESSION_TOKEN, user: USER }, { setsSession: true }),
    );

    expect(body()).toEqual({ token: JWT, user: USER });
  });

  /**
   * @regression   12.6.1 review — the service must hand the policy a session lookup; without one, the second factor of a
   *   signed-in user (no cookie set) still carries the live session token in cookie mode.
   * @seen-failing Build the policy without `isSessionToken` in presentSessionTokens() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation `session-lookup-not-wired` in
   *   tests/regression-mutations.json.
   */
  it('sends a signed-in user’s second factor, which sets no cookie, without the session token in cookie mode', async () => {
    ConfigService.setConfig({ ...(previous as object), cookies: true } as any, { reInit: true, warn: false });
    const { body, res } = expressResponse();

    await CoreBetterAuthService.prototype.sendBetterAuthResponse.call(
      service(),
      res as any,
      betterAuthResponse({ token: SESSION_TOKEN, user: USER }),
    );

    expect(body()).toEqual({ user: USER });
  });

  /**
   * @regression   12.6.1 review — with `advanced.useSecureCookies` (or a renamed session cookie) Better-Auth sets
   *   `__Secure-iam.session_token`; a policy matching the configured name found no session cookie, so a passkey
   *   sign-in in token-in-body mode got no JWT.
   * @seen-failing Ignore the instance's cookie name in sessionCookieNameOfInstance() in
   *   src/core/modules/better-auth/core-better-auth.service.ts — registered as mutation
   *   `session-cookie-name-not-from-instance` in tests/regression-mutations.json.
   */
  it('recognises the session cookie under the name the instance sets (__Secure- prefix)', async () => {
    ConfigService.setConfig({ ...(previous as object), cookies: false } as any, { reInit: true, warn: false });
    const { body, res } = expressResponse();

    await CoreBetterAuthService.prototype.sendBetterAuthResponse.call(
      service(SECURE_COOKIE),
      res as any,
      betterAuthResponse(
        { session: { id: 's1', token: SESSION_TOKEN } },
        { cookieName: SECURE_COOKIE, setsSession: true },
      ),
    );

    expect(body()).toEqual({ session: { id: 's1' }, token: JWT });
  });
});

describe('every place that forwards to Better-Auth sends through the token policy', () => {
  it.each([
    'src/core/modules/better-auth/core-better-auth.controller.ts',
    'src/core/modules/better-auth/core-better-auth-api.middleware.ts',
  ])('%s does not call sendWebResponse() itself', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');

    expect(source).not.toMatch(/\bsendWebResponse\s*\(/);
    expect(source).toMatch(/sendBetterAuthResponse\(res,/);
  });
});
