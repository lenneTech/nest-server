import { hasApiTokenCredential } from '../../modules/api-token/core-api-token.helpers.js';
import { resolveJwtCookieName } from '../../modules/better-auth/better-auth-cookie-prefix.helper.js';
import { isLegacyJwt } from '../../modules/better-auth/core-better-auth-token.helper.js';
import { extractSessionToken, parseCookieHeader } from '../../modules/better-auth/core-better-auth-web.helper.js';
import { getBetterAuthTokenService } from '../../modules/better-auth/core-better-auth.registry.js';
import { ConfigService } from '../services/config.service.js';
import {
  getWsConnection,
  type IWsConnectionSocket,
  noteWsConnectionTenant,
  readWsTenantHeader,
  recheckHttpStreamInPlace,
  registerWsConnection,
  type WsConnection,
} from './graphql-ws-connection.helper.js';

import type { ResolvedTenantContext } from '../services/core-tenant-context.registry.js';

/**
 * Re-checking an OPEN HTTP stream (Server-Sent Events) against the credential it was opened with (12.11.0).
 *
 * An HTTP stream is authorized once, by the guards of the request that opened it. `registerWsConnection()` with
 * `endsOnRecheck` keeps it inside the user's rights by ending it on every re-check, so the client's reconnect passes
 * the guards again — at the price of a reconnect (an EventSource waits its `retry`, ~3 s) before the event that
 * triggered the re-check reaches it. This file re-runs the request's own credential instead, so the stream can be
 * re-checked in place like a GraphQL WebSocket (`recheckHttpStreamInPlace()`).
 *
 * WHICH CREDENTIALS: the ones `CoreBetterAuthMiddleware` resolves, in its order — the bearer token of the
 * `Authorization` header (a Better-Auth JWT or session token), the JWT cookie when no header was sent (`lt-jwt-token`, or
 * `<COOKIE_PREFIX>-jwt-token` with a prefix), then
 * the Better-Auth session cookie (`<prefix>.session_token`, signed or not) — each verified and loaded through
 * Better-Auth's token service, the one the IAM role guard uses. A legacy JWT is Passport's and an API token has checks
 * of its own: neither can be re-run here, and such a stream keeps ending on every re-check.
 */

/** What a request carried to authenticate, as it was when the stream was opened. */
interface HttpStreamCredential {
  authorization?: string;
  cookieHeader?: string;
  cookies?: Record<string, unknown>;
}

function firstHeaderValue(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first ? first : undefined;
}

/** The Better-Auth base path the session cookie name derives from */
function betterAuthBasePath(): string {
  const betterAuth = ConfigService.configFastButReadOnly?.betterAuth;
  const basePath = betterAuth && typeof betterAuth === 'object' ? betterAuth.basePath : undefined;
  return typeof basePath === 'string' && basePath ? basePath : '/iam';
}

/**
 * The tokens to try, in the order `CoreBetterAuthMiddleware` tries them. Only non-empty strings: a cookie parsed from
 * `j:` JSON is an object and is never handed to a lookup (DEV-4138).
 */
function credentialTokens(credential: HttpStreamCredential): string[] {
  const tokens: string[] = [];
  const add = (token: unknown) => {
    if (typeof token === 'string' && token && !tokens.includes(token)) {
      tokens.push(token);
    }
  };
  const isLegacy = (token: string) => token.split('.').length === 3 && isLegacyJwt(token);
  const cookies = credential.cookies ?? parseCookieHeader(credential.cookieHeader);
  if (credential.authorization) {
    const token = credential.authorization.replace(/^bearer\s+/i, '');
    // A legacy JWT is Passport's; the middleware leaves it alone as well
    if (!isLegacy(token)) {
      add(token);
    }
  } else {
    // The cookie `CoreBetterAuthMiddleware` reads: `<COOKIE_PREFIX>-jwt-token`, else `lt-jwt-token` (12.11.2)
    const jwt = cookies?.[resolveJwtCookieName()];
    if (typeof jwt === 'string' && jwt.split('.').length === 3 && !isLegacy(jwt)) {
      add(jwt);
    }
  }
  add(
    extractSessionToken(
      { cookies, headers: { authorization: credential.authorization, cookie: credential.cookieHeader } } as any,
      betterAuthBasePath(),
      { skipAuthHeader: !!credential.authorization },
    ),
  );
  return tokens;
}

/**
 * Build the re-authentication of an HTTP stream from the request that opened it: a function that re-runs the
 * request's Better-Auth credential (bearer token, JWT cookie, session cookie — see the file comment) and
 * resolves to the user it authenticates as NOW, or to `null` when it no longer does (a signed-out or expired session,
 * an expired JWT).
 *
 * The credential is read from the request once, here; the function verifies it again on every call. Answers
 * `undefined` when there is nothing it could re-run: Better-Auth is not active, the request carries an API token, or
 * its only credential is a legacy JWT. Pass the result as `reauthenticate` to `recheckHttpStreamInPlace()`.
 */
export function createHttpStreamReauthenticator(request: any): (() => Promise<any>) | undefined {
  if (!request || typeof request !== 'object' || !getBetterAuthTokenService() || hasApiTokenCredential(request)) {
    return undefined;
  }
  const credential: HttpStreamCredential = {
    authorization: firstHeaderValue(request.headers?.authorization),
    cookieHeader: firstHeaderValue(request.headers?.cookie),
    cookies: request.cookies && typeof request.cookies === 'object' ? { ...request.cookies } : undefined,
  };
  if (!credentialTokens(credential).length) {
    return undefined;
  }
  return async () => {
    // Read at call time: a test module rebuilt in between registers a token service of its own
    const tokenService = getBetterAuthTokenService();
    if (!tokenService) {
      return null;
    }
    for (const token of credentialTokens(credential)) {
      try {
        const user = await tokenService.verifyAndLoadUser(token);
        if (user) {
          return user;
        }
      } catch {
        // An expired JWT: the middleware goes on to the session cookie, and so does this
      }
    }
    return null;
  };
}

/** What {@link registerHttpStream} needs to know about a stream. */
export interface IHttpStreamRegistration {
  /** The object the stream is identified by (`getWsConnection(carrier)`). Default: a new object. */
  carrier?: object;

  /** How the log names the stream when it is closed, e.g. `SSE hint stream`. Default `HTTP stream`. */
  channel?: string;

  /**
   * Re-run the credential the stream was opened with. Default: {@link createHttpStreamReauthenticator} of `request`.
   * `false` keeps the stream ending on every re-check (the behaviour before 12.11.0).
   */
  reauthenticate?: (() => any) | false;

  /** The HTTP request the stream was opened with: its credential and its tenant header are re-checked. */
  request: any;

  /** Closes the stream (with the close code as first argument, which a stream ignores) and reports its end. */
  socket: IWsConnectionSocket;

  /**
   * The tenant scope the stream's reads are scoped by — what the guards resolved for the request (`RequestContext`:
   * `tenantId`, `tenantIds`, `tenantRole`, `isAdminBypass`). A re-check closes the stream when it resolves
   * differently. Without it the tenant scope is not re-checked.
   */
  tenant?: ResolvedTenantContext;

  /** The user the guards authenticated for the request (`@CurrentUser()`). */
  user: any;
}

/**
 * Register an HTTP stream (Server-Sent Events) for the authorization lifecycle of `graphql-ws-connection.helper.ts`
 * and let it be re-checked in place when its credential can be re-run (12.11.0).
 *
 * Re-checked in place, the stream stays open while the rights are unchanged — an event after
 * `graphQl.subscriptionRevalidationMs` or after an invalidation is delivered without a reconnect — and is closed when
 * user id, roles, verification or tenant scope changed. A stream whose credential cannot be re-run (see
 * {@link createHttpStreamReauthenticator}) ends on every re-check as before, and the client's reconnect passes the
 * guards again.
 *
 * Call `ensureWsConnectionCurrent(connection)` before every event and send the event only when it answers `true`.
 * Register the stream before anything may end it, and end it through `socket.close()`; report its end through the
 * `close` listener of `socket.once()`.
 */
export async function registerHttpStream(registration: IHttpStreamRegistration): Promise<undefined | WsConnection> {
  const { channel, request, socket, tenant, user } = registration;
  const carrier = registration.carrier ?? {};
  registerWsConnection({ carrier, channel: channel || 'HTTP stream', endsOnRecheck: true, socket, user });
  const connection = getWsConnection(carrier);
  if (!connection) {
    return undefined;
  }
  if (tenant) {
    noteWsConnectionTenant(connection, tenant);
  }
  const reauthenticate =
    registration.reauthenticate === false
      ? undefined
      : (registration.reauthenticate ?? createHttpStreamReauthenticator(request));
  if (reauthenticate) {
    await recheckHttpStreamInPlace(connection, { reauthenticate, tenantHeader: readWsTenantHeader(request) });
  }
  return connection;
}
