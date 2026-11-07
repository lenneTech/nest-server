import { isJwtShaped } from './core-better-auth-token.helper.js';

/**
 * How a response Better-Auth produced itself may carry the session token (see {@link presentSessionTokens}).
 */
export interface SessionTokenPresentation {
  /** Name of the session cookie Better-Auth sets (`<prefix>.session_token`, `__Secure-` prefixed with secure cookies) */
  cookieName: string;
  /**
   * Whether a value is the token of a live session — asked only for a top-level `token` the response does not
   * already identify as the session token (no session cookie set, no `session.token`). A signed-in user verifying a
   * second factor gets the token of the session they already hold, with no cookie; without this check that token
   * would pass as another plugin's value.
   */
  isSessionToken?: (token: string) => Promise<boolean>;
  /**
   * Turns an opaque session token into what the body should carry instead — a JWT when the JWT plugin is on
   * (`CoreBetterAuthService.resolveJwtToken()`), the token itself when it is off, `undefined` when a conversion failed
   */
  resolveJwt: (sessionToken: string) => Promise<string | undefined>;
  /**
   * Whether the body may carry a token at all: cookies disabled (JWT-only mode) or `cookies.exposeTokenInBody`.
   * `false` in the default cookie mode, where the session lives in an httpOnly cookie and nowhere else.
   */
  tokenInBody: boolean;
}

/**
 * The session token a response sets in its session cookie, or `undefined` when it sets none.
 *
 * A Better-Auth endpoint that CREATES a session (two-factor verify, passkey verify, OTP and magic-link sign-in, …)
 * sets this cookie; that is how the token in its body is recognised as the session token rather than some other
 * value a plugin names `token`. The cookie value is signed (`<token>.<signature>`, URL-encoded).
 *
 * When a response sets the cookie more than once, the LAST one counts, as in the browser: a session refresh during
 * the request (Better-Auth's `getSessionFromCtx()`, once per `updateAge`) sets the current session's cookie first, and
 * an endpoint that then replaces the session (enabling 2FA) sets the new one after it (12.7.1).
 */
export function sessionTokenFromSetCookie(response: globalThis.Response, cookieName: string): string | undefined {
  let token: string | undefined;
  for (const header of response.headers.getSetCookie?.() ?? []) {
    if (!header.startsWith(`${cookieName}=`)) {
      continue;
    }
    const raw = header.split(';')[0].slice(cookieName.length + 1);
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
    token = value.split('.')[0] || undefined;
  }
  return token;
}

/**
 * Applies the sign-in token policy to a response Better-Auth produced itself — every route the framework forwards
 * to Better-Auth's handler instead of answering it in `CoreBetterAuthController` (two-factor verify-totp /
 * verify-backup-code / verify-otp, passkey verify, OTP and magic-link sign-in, get-session, …).
 *
 * Better-Auth answers a session-creating route with `{ token: <session token>, user }`, and its session objects carry
 * `session.token`. The framework's own sign-in never lets that reach a client: in the default cookie mode the token
 * lives in an httpOnly cookie only, and where the body may carry a token it is a JWT (SEC-005). Forwarded routes
 * bypassed both, so a frontend found the opaque 7-day session token in the body of the second factor and stored it
 * where any script could read it.
 *
 * - Cookie mode: the session token leaves the body — top-level `token` and `session.token`.
 * - Token in body: the session token becomes {@link SessionTokenPresentation.resolveJwt}'s answer; `session.token`
 *   leaves the body as in sign-in (`mapSession()`). A response that created a session without a top-level token
 *   (passkey verify answers `{ session }`) gains one.
 * - Session records (an object with a `token`, a `userId` and an `expiresAt`) lose their `token` in every mode, also
 *   inside an array: `list-sessions` answered every session of the user with its token (12.7.0). The client revokes a
 *   session by its `id` instead (`POST /revoke-session` with `{ sessionId }`).
 * - A response in the shape `{ token, user }` that sets a new session cookie while its body names another opaque token
 *   rotated the session (the first verify-totp while enabling 2FA answers with the token of the session it deleted):
 *   that token is treated as the session token — removed in cookie mode, replaced by the JWT of the NEW session where
 *   the body carries one (12.7.1). A plugin's own `{ token }` next to a refreshed session cookie is not a rotation.
 * - Untouched: error responses, non-JSON bodies, a JWT (`/token` hands one out on purpose), and a top-level `token`
 *   that is not the session token (another plugin's value).
 *
 * Returns the response itself when nothing changes, otherwise a new one with the same status and headers.
 */
export async function presentSessionTokens(
  response: globalThis.Response,
  options: SessionTokenPresentation,
): Promise<globalThis.Response> {
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) {
    return response;
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!body || typeof body !== 'object') {
    return response;
  }
  if (Array.isArray(body)) {
    return body.some(isSessionRecord)
      ? rebuildResponse(
          response,
          body.map((item) => (isSessionRecord(item) ? withoutToken(item) : item)),
        )
      : response;
  }
  if (isSessionRecord(body)) {
    return rebuildResponse(response, withoutToken(body));
  }

  const record = body as Record<string, unknown>;
  const session =
    record.session && typeof record.session === 'object' && !Array.isArray(record.session)
      ? (record.session as Record<string, unknown>)
      : undefined;
  const sessionFieldToken = typeof session?.token === 'string' && session.token ? session.token : undefined;
  const cookieToken = sessionTokenFromSetCookie(response, options.cookieName);
  const topToken = typeof record.token === 'string' && record.token ? record.token : undefined;
  // A response that sets a NEW session cookie while its body names another opaque token rotated the session: the
  // body token is the one it just replaced (and deleted). Better-Auth's first verify-totp while enabling 2FA does that.
  // Only in the shape of a session-creating answer, `{ token, user }`: a session refresh sets the cookie on ANY
  // session-protected request, so a plugin's own token (`/one-time-token/generate` answers `{ token }`) can sit next
  // to a session cookie as well, and must stay what it is.
  const answersWithUser = !!record.user && typeof record.user === 'object' && !Array.isArray(record.user);
  const rotatedFrom =
    answersWithUser && !!topToken && !isJwtShaped(topToken) && !!cookieToken && topToken !== cookieToken;
  const topIsSessionToken =
    !!topToken &&
    !isJwtShaped(topToken) &&
    (topToken === cookieToken ||
      rotatedFrom ||
      topToken === sessionFieldToken ||
      (await isLiveSessionToken(topToken, options.isSessionToken)));

  if (!topIsSessionToken && !sessionFieldToken) {
    return response;
  }

  const next: Record<string, unknown> = { ...record };
  if (session && sessionFieldToken) {
    const { token: _sessionToken, ...rest } = session;
    next.session = rest;
  }

  if (!options.tokenInBody) {
    if (topIsSessionToken) {
      delete next.token;
    }
  } else {
    // The session token the body should present: the one this response set when it rotated the session, else the
    // top-level one, else the one this response just set
    const source = rotatedFrom ? cookieToken : topIsSessionToken ? topToken : !topToken ? cookieToken : undefined;
    if (source) {
      const presented = await options.resolveJwt(source);
      if (presented) {
        next.token = presented;
      } else {
        delete next.token;
      }
    }
  }

  return rebuildResponse(response, next);
}

/**
 * A session as Better-Auth outputs it (`parseSessionOutput()`): its `token` is the bearer credential of that session,
 * so it never belongs in a body — the `id` identifies the session to the client.
 */
function isSessionRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.token === 'string' && !!record.token && 'userId' in record && 'expiresAt' in record;
}

/** The record without its `token` */
function withoutToken(record: Record<string, unknown>): Record<string, unknown> {
  const { token: _token, ...rest } = record;
  return rest;
}

/** The same response with another JSON body: status and headers kept, every `Set-Cookie` re-appended */
function rebuildResponse(response: globalThis.Response, body: unknown): globalThis.Response {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'set-cookie') {
      headers.set(key, value);
    }
  });
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    headers.append('set-cookie', cookie);
  }
  return new Response(JSON.stringify(body), { headers, status: response.status, statusText: response.statusText });
}

/** Asks {@link SessionTokenPresentation.isSessionToken}; a lookup that fails cannot vouch for anything */
async function isLiveSessionToken(
  token: string,
  isSessionToken: SessionTokenPresentation['isSessionToken'],
): Promise<boolean> {
  if (!isSessionToken) {
    return false;
  }
  try {
    return (await isSessionToken(token)) === true;
  } catch {
    return false;
  }
}
