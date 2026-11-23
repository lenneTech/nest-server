import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureWsConnectionCurrent,
  getWsConnection,
  noteWsConnectionTenant,
  recheckHttpStreamInPlace,
  registerWsConnection,
  revalidateWsConnectionsOf,
  WS_AUTHORIZATION_CHANGED_CLOSE_CODE,
} from '../../src/core/common/helpers/graphql-ws-connection.helper';
import {
  createHttpStreamReauthenticator,
  registerHttpStream,
} from '../../src/core/common/helpers/http-stream-auth.helper';
import { ConfigService } from '../../src/core/common/services/config.service';
import {
  getTenantContextResolver,
  setTenantContextResolver,
} from '../../src/core/common/services/core-tenant-context.registry';
import {
  getBetterAuthTokenService,
  setBetterAuthTokenService,
} from '../../src/core/modules/better-auth/core-better-auth.registry';

/**
 * An HTTP stream (Server-Sent Events) re-checked IN PLACE (12.11.0).
 *
 * Until 12.11.0 a stream registered with `endsOnRecheck` ended on the first event after
 * `graphQl.subscriptionRevalidationMs` and on every invalidation, and the client got that event only after its
 * reconnect. `recheckHttpStreamInPlace()` re-runs the request's credential instead and keeps the stream open while the
 * rights are unchanged — the semantics a GraphQL WebSocket has. The WebSocket half of the mechanism is pinned in
 * tests/unit/graphql-ws-connection.spec.ts; tests/unit/sync-hint-stream-recheck.spec.ts pins the sync hint stream.
 */
class FakeSocket extends EventEmitter {
  close = vi.fn((code?: number, reason?: string) => {
    this.emit('close', code, reason);
  });
}

const USER = { email: 'anna@example.com', id: 'user-1', roles: ['editor'], verified: true };

describe('HTTP stream re-checked in place', () => {
  let previousConfig: Record<string, any>;
  let previousResolver: ReturnType<typeof getTenantContextResolver>;
  let previousTokenService: ReturnType<typeof getBetterAuthTokenService>;
  let log: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;
  const sockets: FakeSocket[] = [];

  const setRevalidationMs = (value: unknown) =>
    ConfigService.setConfig({ ...previousConfig, graphQl: { subscriptionRevalidationMs: value } } as any, {
      reInit: true,
      warn: false,
    });

  /** A stream as an SSE route registers it before the switch: ends on every re-check */
  const openStream = (user: any = USER) => {
    const carrier: Record<string, any> = {};
    const socket = new FakeSocket();
    sockets.push(socket);
    registerWsConnection({ carrier, channel: 'SSE test stream', endsOnRecheck: true, socket, user });
    const connection = getWsConnection(carrier);
    if (!connection) {
      throw new Error('stream was not registered');
    }
    return { connection, socket };
  };

  /** A re-authentication whose answer a case changes through `current.user` */
  const credential = (user: any = USER) => {
    const current = { user };
    const reauthenticate = vi.fn(async () => current.user);
    return { current, reauthenticate };
  };

  beforeAll(() => {
    previousConfig = { ...(ConfigService.configFastButReadOnly as any) };
    previousResolver = getTenantContextResolver();
    previousTokenService = getBetterAuthTokenService();
  });

  beforeEach(() => {
    setRevalidationMs(1000);
    setTenantContextResolver(undefined);
    setBetterAuthTokenService(null);
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    log.mockRestore();
    debug.mockRestore();
    for (const socket of sockets.splice(0)) {
      socket.emit('close', 1000, 'case finished');
    }
  });

  afterAll(() => {
    ConfigService.setConfig(previousConfig as any, { reInit: true, warn: false });
    setTenantContextResolver(previousResolver);
    setBetterAuthTokenService(previousTokenService);
  });

  describe('recheckHttpStreamInPlace()', () => {
    it('stays open past the interval while the rights are unchanged, re-running the credential', async () => {
      vi.useFakeTimers();
      const { connection, socket } = openStream();
      const { reauthenticate } = credential();

      expect(await recheckHttpStreamInPlace(connection, { reauthenticate })).toBe(true);
      expect(connection.endsOnRecheck).toBe(false);
      expect(reauthenticate).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1001);
      expect(await ensureWsConnectionCurrent(connection)).toBe(true);
      expect(reauthenticate).toHaveBeenCalledTimes(2);
      expect(socket.close).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('re-check interval reached'));
    });

    it('stays open on an invalidation that changed nothing', async () => {
      const { connection, socket } = openStream();
      const { reauthenticate } = credential();
      await recheckHttpStreamInPlace(connection, { reauthenticate });

      expect(revalidateWsConnectionsOf({ userId: 'user-1' })).toBe(1);
      await vi.waitFor(() => expect(reauthenticate).toHaveBeenCalledTimes(2));
      expect(await ensureWsConnectionCurrent(connection)).toBe(true);
      expect(socket.close).not.toHaveBeenCalled();
    });

    it('closes with 4403 under the stream name when the roles changed — in either direction', async () => {
      for (const roles of [[], ['editor', 'admin']]) {
        const { connection, socket } = openStream();
        const { current, reauthenticate } = credential();
        await recheckHttpStreamInPlace(connection, { reauthenticate });

        current.user = { ...USER, roles };
        revalidateWsConnectionsOf({ userId: 'user-1' });
        await vi.waitFor(() => expect(socket.close).toHaveBeenCalledTimes(1));
        expect(socket.close).toHaveBeenCalledWith(WS_AUTHORIZATION_CHANGED_CLOSE_CODE, 'User authorization changed');
        expect(await ensureWsConnectionCurrent(connection)).toBe(false);
      }
      expect(log).toHaveBeenCalledWith('Closing SSE test stream of user user-1: User authorization changed');
    });

    it('closes when the credential no longer authenticates, and when re-running it throws', async () => {
      const signedOut = openStream();
      const expired = credential();
      await recheckHttpStreamInPlace(signedOut.connection, { reauthenticate: expired.reauthenticate });
      expired.current.user = null;
      revalidateWsConnectionsOf({ userId: 'user-1' });
      await vi.waitFor(() => expect(signedOut.socket.close).toHaveBeenCalledTimes(1));
      expect(log).toHaveBeenCalledWith('Closing SSE test stream of user user-1: Session no longer valid');

      const failing = openStream();
      const throwing = credential();
      await recheckHttpStreamInPlace(failing.connection, { reauthenticate: throwing.reauthenticate });
      throwing.reauthenticate.mockRejectedValueOnce(new Error('store down'));
      revalidateWsConnectionsOf({ userId: 'user-1' });
      await vi.waitFor(() => expect(failing.socket.close).toHaveBeenCalledTimes(1));
    });

    it('closes when the tenant scope resolves differently than the stream was authorized with', async () => {
      const resolved = { tenantId: 'tenant-a', tenantRole: 'member' };
      const resolve = vi.fn(async () => ({ ...resolved }));
      setTenantContextResolver({ resolve });
      const { connection, socket } = openStream();
      noteWsConnectionTenant(connection, { tenantId: 'tenant-a', tenantRole: 'member' });
      const { reauthenticate } = credential();

      expect(await recheckHttpStreamInPlace(connection, { reauthenticate, tenantHeader: 'tenant-a' })).toBe(true);
      expect(resolve).toHaveBeenLastCalledWith(USER, 'tenant-a');

      // The membership is gone: the resolver no longer validates the header
      resolve.mockResolvedValue({} as any);
      revalidateWsConnectionsOf({ userId: 'user-1' });
      await vi.waitFor(() => expect(socket.close).toHaveBeenCalledTimes(1));
      expect(socket.close).toHaveBeenCalledWith(WS_AUTHORIZATION_CHANGED_CLOSE_CODE, 'Tenant access changed');
      expect(resolve).toHaveBeenLastCalledWith(USER, 'tenant-a');
    });

    /**
     * The paired refusal: a re-run credential that answers the user in another SHAPE (or with other rights) than the
     * guards did cannot tell a later change from that difference. Switched anyway, the stream would compare every
     * re-check against a user it never matched.
     */
    it('keeps ending on every re-check when the re-run credential does not answer the authorized user as it was', async () => {
      const cases: Array<{ reason: string; reauthenticate: () => any; tenant?: true }> = [
        { reason: 'its credential cannot be re-run', reauthenticate: async () => null },
        { reason: 'its credential cannot be re-run', reauthenticate: () => Promise.reject(new Error('expired')) },
        {
          reason: 'the re-run credential does not answer the authorized user with the same rights',
          reauthenticate: async () => ({ ...USER, roles: ['editor', 'admin'] }),
        },
        {
          reason: 'the re-run credential does not answer the authorized user with the same rights',
          reauthenticate: async () => ({ ...USER, id: 'user-2' }),
        },
        { reason: 'its tenant scope resolves differently', reauthenticate: async () => USER, tenant: true },
      ];
      setTenantContextResolver({ resolve: async () => ({ tenantIds: ['tenant-b'] }) });
      for (const { reason, reauthenticate, tenant } of cases) {
        const { connection, socket } = openStream();
        if (tenant) {
          noteWsConnectionTenant(connection, { tenantIds: ['tenant-a'] });
        }
        expect(await recheckHttpStreamInPlace(connection, { reauthenticate }), reason).toBe(false);
        expect(connection.endsOnRecheck).toBe(true);
        expect(debug).toHaveBeenCalledWith(`SSE test stream of user user-1 ends on every re-check: ${reason}`);

        // ... and so it ends at the next re-check, as before 12.11.0
        expect(revalidateWsConnectionsOf({ userId: 'user-1' })).toBe(1);
        await vi.waitFor(() => expect(socket.close).toHaveBeenCalledTimes(1));
      }
    });

    it('leaves a WebSocket, a closed stream and a stream invalidated while the credential ran alone', async () => {
      const carrier = {};
      const webSocket = new FakeSocket();
      sockets.push(webSocket);
      const wsCredential = credential();
      registerWsConnection({ carrier, reauthenticate: wsCredential.reauthenticate, socket: webSocket, user: USER });
      expect(await recheckHttpStreamInPlace(getWsConnection(carrier), credential())).toBe(false);
      expect(await recheckHttpStreamInPlace(undefined, credential())).toBe(false);

      const closed = openStream();
      closed.socket.emit('close');
      expect(await recheckHttpStreamInPlace(closed.connection, credential())).toBe(false);

      // An invalidation arriving while the credential runs still ends the stream: it was not switched yet
      const racing = openStream();
      const slow = credential();
      slow.reauthenticate.mockImplementationOnce(async () => {
        revalidateWsConnectionsOf({ userId: 'user-1' });
        return USER;
      });
      expect(await recheckHttpStreamInPlace(racing.connection, { reauthenticate: slow.reauthenticate })).toBe(false);
      expect(racing.socket.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('createHttpStreamReauthenticator()', () => {
    const SESSION_TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
    /** A Better-Auth JWT: three parts, a `sub` claim */
    const jwt = (payload: Record<string, unknown>) =>
      ['eyJhbGciOiJFZERTQSJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'c2lnbmF0dXJl'].join('.');
    const IAM_JWT = jwt({ email: USER.email, sub: 'user-1' });
    /** A legacy JWT: `id` and no `sub` — Passport's */
    const LEGACY_JWT = jwt({ deviceId: 'd', id: 'user-1', tokenId: 't' });

    /** The token service the IAM role guard uses, answering the user for the tokens it knows */
    const tokenService = (known: Record<string, any>) => {
      const service = {
        verifyAndLoadUser: vi.fn(async (token: string) => {
          const answer = known[token];
          if (answer instanceof Error) {
            throw answer;
          }
          return answer ?? null;
        }),
      };
      setBetterAuthTokenService(service as any);
      return service;
    };

    it('answers nothing without Better-Auth', () => {
      expect(
        createHttpStreamReauthenticator({ headers: { authorization: `Bearer ${SESSION_TOKEN}` } }),
      ).toBeUndefined();
      expect(createHttpStreamReauthenticator(undefined)).toBeUndefined();
    });

    it('re-runs a bearer session token or Better-Auth JWT through the token service — again on every call', async () => {
      const service = tokenService({ [IAM_JWT]: USER, [SESSION_TOKEN]: USER });
      for (const authorization of [`Bearer ${SESSION_TOKEN}`, `bearer ${IAM_JWT}`]) {
        const reauthenticate = createHttpStreamReauthenticator({ headers: { authorization } });
        expect(await reauthenticate?.()).toBe(USER);
        expect(await reauthenticate?.()).toBe(USER);
      }
      expect(service.verifyAndLoadUser.mock.calls.map(([token]) => token)).toEqual([
        SESSION_TOKEN,
        SESSION_TOKEN,
        IAM_JWT,
        IAM_JWT,
      ]);
    });

    it('re-runs the session cookie, signed or not, and the JWT cookie of a JWT-mode frontend', async () => {
      const service = tokenService({ [IAM_JWT]: USER, [SESSION_TOKEN]: USER });
      const signature = 'A'.repeat(43) + '=';
      for (const request of [
        { cookies: { 'iam.session_token': `${SESSION_TOKEN}.${signature}` }, headers: {} },
        { headers: { cookie: `iam.session_token=${encodeURIComponent(`${SESSION_TOKEN}.${signature}`)}` } },
        { cookies: { 'lt-jwt-token': IAM_JWT }, headers: {} },
      ]) {
        expect(await createHttpStreamReauthenticator(request)?.()).toBe(USER);
      }
      expect(service.verifyAndLoadUser.mock.calls.map(([token]) => token)).toEqual([
        SESSION_TOKEN,
        SESSION_TOKEN,
        IAM_JWT,
      ]);
    });

    it('goes on to the session cookie when the bearer token fails, as the middleware does', async () => {
      tokenService({ [IAM_JWT]: new Error('JWT expired'), [SESSION_TOKEN]: USER });
      const reauthenticate = createHttpStreamReauthenticator({
        cookies: { 'iam.session_token': SESSION_TOKEN },
        headers: { authorization: `Bearer ${IAM_JWT}` },
      });
      expect(await reauthenticate?.()).toBe(USER);
    });

    it('answers null once nothing the request carried authenticates any more', async () => {
      const known: Record<string, any> = { [SESSION_TOKEN]: USER };
      tokenService(known);
      const reauthenticate = createHttpStreamReauthenticator({ headers: { authorization: `Bearer ${SESSION_TOKEN}` } });
      expect(await reauthenticate?.()).toBe(USER);
      delete known[SESSION_TOKEN];
      expect(await reauthenticate?.()).toBeNull();
      setBetterAuthTokenService(null);
      expect(await reauthenticate?.()).toBeNull();
    });

    /**
     * The paired refusal: a credential the token service cannot re-run must not be replaced by another one the request
     * happens to carry. A legacy JWT is Passport's, a non-string cookie (cookie-parser's `j:` JSON) is never a token.
     */
    it('answers nothing for a legacy JWT or a cookie that is not a string', async () => {
      const service = tokenService({ [LEGACY_JWT]: USER });
      expect(createHttpStreamReauthenticator({ headers: { authorization: `Bearer ${LEGACY_JWT}` } })).toBeUndefined();
      expect(
        createHttpStreamReauthenticator({ cookies: { 'iam.session_token': { $ne: null } as any }, headers: {} }),
      ).toBeUndefined();
      expect(createHttpStreamReauthenticator({ headers: {} })).toBeUndefined();
      expect(service.verifyAndLoadUser).not.toHaveBeenCalled();
    });

    it('answers nothing for a request carrying an API token', () => {
      tokenService({});
      ConfigService.setConfig({ ...previousConfig, apiTokens: { scopes: ['read'] } } as any, {
        reInit: true,
        warn: false,
      });
      const apiToken = `ltt_${'a'.repeat(24)}_${'b'.repeat(64)}`;
      expect(
        createHttpStreamReauthenticator({
          cookies: { 'iam.session_token': SESSION_TOKEN },
          headers: { authorization: `Bearer ${apiToken}` },
        }),
      ).toBeUndefined();
    });
  });

  describe('registerHttpStream()', () => {
    it('re-checks a stream with a Better-Auth credential in place, and closes it only when the rights changed', async () => {
      const current = { user: USER as any };
      setBetterAuthTokenService({ verifyAndLoadUser: vi.fn(async () => current.user) } as any);
      setRevalidationMs(0);
      const socket = new FakeSocket();
      sockets.push(socket);
      const request = { headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' } };

      const connection = await registerHttpStream({
        channel: 'SSE test stream',
        request,
        socket,
        tenant: {},
        user: USER,
      });
      expect(connection?.endsOnRecheck).toBe(false);
      // 0: re-checked before every event — and kept open each time
      expect(await ensureWsConnectionCurrent(connection!)).toBe(true);
      expect(await ensureWsConnectionCurrent(connection!)).toBe(true);
      expect(socket.close).not.toHaveBeenCalled();

      current.user = { ...USER, verified: false };
      expect(await ensureWsConnectionCurrent(connection!)).toBe(false);
      expect(socket.close).toHaveBeenCalledWith(WS_AUTHORIZATION_CHANGED_CLOSE_CODE, 'User authorization changed');
    });

    it('keeps ending on every re-check without a credential it can re-run, or with reauthenticate: false', async () => {
      setRevalidationMs(0);
      setBetterAuthTokenService({ verifyAndLoadUser: vi.fn(async () => USER) } as any);
      for (const registration of [
        { request: { headers: {} } },
        {
          reauthenticate: false as const,
          request: { headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' } },
        },
      ]) {
        const socket = new FakeSocket();
        sockets.push(socket);
        const connection = await registerHttpStream({ ...registration, socket, user: USER });
        expect(connection?.endsOnRecheck).toBe(true);
        expect(await ensureWsConnectionCurrent(connection!)).toBe(false);
        expect(socket.close).toHaveBeenCalledTimes(1);
        expect(debug).toHaveBeenCalledWith(
          'Closing HTTP stream of user user-1: re-check interval reached, client reconnects',
        );
      }
    });
  });
});
