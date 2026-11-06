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
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';
import {
  presentSessionTokens,
  sessionTokenFromSetCookie,
} from '../../src/core/modules/better-auth/core-better-auth-session-token.helper';

const COOKIE = 'iam.session_token';
const SESSION_TOKEN = 'Xq3vS9kLm2Pz8RtYw4Bn6Cd1Fg5Hj7Ka';
const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const USER = { email: 'two.factor@test.com', id: 'u1' };

/** A JSON response as Better-Auth's handler answers, optionally setting the session cookie */
function betterAuthResponse(body: unknown, options: { setsSession?: boolean; status?: number } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.setsSession) {
    headers.append('set-cookie', `${COOKIE}=${encodeURIComponent(`${SESSION_TOKEN}.c2lnbmF0dXJl`)}; Path=/; HttpOnly`);
  }
  headers.append('set-cookie', 'iam.dont_remember=; Max-Age=0; Path=/');
  return new Response(JSON.stringify(body), { headers, status: options.status ?? 200 });
}

function policy(tokenInBody: boolean, resolveJwt = vi.fn(async (_token: string) => JWT)) {
  return { options: { cookieName: COOKIE, resolveJwt, tokenInBody }, resolveJwt };
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
      ['a list (list-sessions)', betterAuthResponse([{ token: SESSION_TOKEN }])],
      ['a body without any token', betterAuthResponse({ status: true })],
    ])('%s', async (_case, response) => {
      const { options } = policy(false);

      expect(await presentSessionTokens(response, options)).toBe(response);
    });

    it('a response that is no JSON', async () => {
      const response = new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      const { options } = policy(false);

      expect(await presentSessionTokens(response, options)).toBe(response);
    });
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

  function service() {
    return {
      getSessionCookieName: () => COOKIE,
      presentSessionTokens: CoreBetterAuthService.prototype.presentSessionTokens,
      resolveJwtToken: vi.fn(async (token: string) => (token === SESSION_TOKEN ? JWT : token)),
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
