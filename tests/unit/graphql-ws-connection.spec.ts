import { EventEmitter } from 'events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SUBSCRIPTION_REVALIDATION_MS,
  ensureWsConnectionCurrent,
  getWsConnection,
  noteWsConnectionTenant,
  registerWsConnection,
  resolveSubscriptionRevalidationMs,
  revalidateAllWsConnections,
  revalidateWsConnectionsForTenant,
  revalidateWsConnectionsOf,
  WS_AUTHORIZATION_CHANGED_CLOSE_CODE,
} from '../../src/core/common/helpers/graphql-ws-connection.helper';
import { ConfigService } from '../../src/core/common/services/config.service';
import {
  getTenantContextResolver,
  setTenantContextResolver,
} from '../../src/core/common/services/core-tenant-context.registry';

/**
 * The authorization lifecycle of an OPEN WebSocket connection.
 *
 * Before 11.42.3 a connection was authorized exactly once: `onConnect` validated the session and
 * recorded the user, and the subscribe wrapper resolved the tenant. Everything that followed — every
 * delivered event, every further operation on the same socket — ran on that snapshot. A removed
 * membership, a deactivated tenant, a withdrawn role or a revoked session changed nothing for a socket
 * that was already open, for as long as the client kept it open.
 *
 * These cases pin the decision logic in isolation; `tests/subscription-revalidation.e2e-spec.ts`
 * drives the same logic over a real socket.
 */
class FakeSocket extends EventEmitter {
  close = vi.fn((code?: number, reason?: string) => {
    this.emit('close', code, reason);
  });
}

const USER = { email: 'Anna@Example.com', iamId: 'iam-1', id: 'user-1', roles: ['editor', 'auditor'] };

describe('graphql-ws connection revalidation', () => {
  let previousConfig: Record<string, any>;
  let previousResolver: ReturnType<typeof getTenantContextResolver>;
  /** Every fake socket of a case, closed afterwards so no connection outlives the case it belongs to. */
  const sockets: FakeSocket[] = [];

  const setRevalidationMs = (value: unknown) =>
    ConfigService.setConfig({ ...previousConfig, graphQl: { subscriptionRevalidationMs: value } } as any, {
      reInit: true,
      warn: false,
    });

  /** Register a connection whose re-authentication answers whatever `current.user` holds. */
  const connect = (user: any = USER) => {
    const carrier: Record<string, any> = {};
    const socket = new FakeSocket();
    sockets.push(socket);
    const current = { user: user as any };
    const reauthenticate = vi.fn(async () => current.user);
    registerWsConnection({ carrier, reauthenticate, socket, user });
    const connection = getWsConnection(carrier);
    if (!connection) {
      throw new Error('connection was not registered');
    }
    return { carrier, connection, current, reauthenticate, socket };
  };

  beforeAll(() => {
    previousConfig = { ...(ConfigService.configFastButReadOnly as any) };
    previousResolver = getTenantContextResolver();
  });

  beforeEach(() => {
    setRevalidationMs(1000);
    setTenantContextResolver(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const socket of sockets.splice(0)) {
      socket.emit('close', 1000, 'case finished');
    }
  });

  afterAll(() => {
    ConfigService.setConfig(previousConfig as any, { reInit: true, warn: false });
    setTenantContextResolver(previousResolver);
  });

  describe('resolveSubscriptionRevalidationMs', () => {
    it('defaults to 30 seconds when unset', () => {
      expect(resolveSubscriptionRevalidationMs(undefined)).toBe(DEFAULT_SUBSCRIPTION_REVALIDATION_MS);
      expect(DEFAULT_SUBSCRIPTION_REVALIDATION_MS).toBe(30_000);
    });

    it('takes a positive interval, and 0 as "on every operation and event"', () => {
      expect(resolveSubscriptionRevalidationMs(5000)).toBe(5000);
      expect(resolveSubscriptionRevalidationMs(0)).toBe(0);
    });

    it('is switched off only by an explicit false', () => {
      expect(resolveSubscriptionRevalidationMs(false)).toBe(false);
      expect(resolveSubscriptionRevalidationMs('false')).toBe(false);
    });

    it('falls back to the default for a value that is not a usable interval — never to "off"', () => {
      for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '', null, {}, true]) {
        expect(resolveSubscriptionRevalidationMs(invalid), String(invalid)).toBe(DEFAULT_SUBSCRIPTION_REVALIDATION_MS);
      }
      expect(resolveSubscriptionRevalidationMs('2500')).toBe(2500);
    });
  });

  describe('ensureWsConnectionCurrent', () => {
    it('does not re-authenticate inside the interval', async () => {
      const { connection, reauthenticate } = connect();
      expect(await ensureWsConnectionCurrent(connection)).toBe(true);
      expect(reauthenticate).not.toHaveBeenCalled();
    });

    it('re-authenticates once the interval has passed, and keeps an unchanged connection open', async () => {
      vi.useFakeTimers();
      const { connection, reauthenticate, socket } = connect();
      vi.advanceTimersByTime(1001);
      expect(await ensureWsConnectionCurrent(connection)).toBe(true);
      expect(reauthenticate).toHaveBeenCalledTimes(1);
      expect(socket.close).not.toHaveBeenCalled();

      // Validated again just now — the next check inside the interval is free.
      expect(await ensureWsConnectionCurrent(connection)).toBe(true);
      expect(reauthenticate).toHaveBeenCalledTimes(1);
    });

    it('re-authenticates on every check with an interval of 0', async () => {
      setRevalidationMs(0);
      const { connection, reauthenticate } = connect();
      await ensureWsConnectionCurrent(connection);
      await ensureWsConnectionCurrent(connection);
      expect(reauthenticate).toHaveBeenCalledTimes(2);
    });

    it('never re-authenticates on its own when switched off with false', async () => {
      setRevalidationMs(false);
      vi.useFakeTimers();
      const { connection, reauthenticate } = connect();
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(await ensureWsConnectionCurrent(connection)).toBe(true);
      expect(reauthenticate).not.toHaveBeenCalled();
    });

    it('shares one re-authentication between concurrent checks', async () => {
      setRevalidationMs(0);
      const { connection, reauthenticate } = connect();
      const results = await Promise.all([
        ensureWsConnectionCurrent(connection),
        ensureWsConnectionCurrent(connection),
        ensureWsConnectionCurrent(connection),
      ]);
      expect(results).toEqual([true, true, true]);
      expect(reauthenticate).toHaveBeenCalledTimes(1);
    });

    it('closes the socket with 4403 when the credential no longer authenticates', async () => {
      setRevalidationMs(0);
      const { connection, current, socket } = connect();
      current.user = null;
      expect(await ensureWsConnectionCurrent(connection)).toBe(false);
      expect(socket.close).toHaveBeenCalledWith(WS_AUTHORIZATION_CHANGED_CLOSE_CODE, expect.any(String));
      expect(WS_AUTHORIZATION_CHANGED_CLOSE_CODE).toBe(4403);
    });

    it('fails closed when re-authentication throws', async () => {
      setRevalidationMs(0);
      const { connection, reauthenticate, socket } = connect();
      reauthenticate.mockRejectedValueOnce(new Error('database unreachable'));
      expect(await ensureWsConnectionCurrent(connection)).toBe(false);
      expect(socket.close).toHaveBeenCalledWith(WS_AUTHORIZATION_CHANGED_CLOSE_CODE, expect.any(String));
    });

    it('closes when the global roles changed — in either direction', async () => {
      setRevalidationMs(0);
      const narrowed = connect();
      narrowed.current.user = { ...USER, roles: ['editor'] };
      expect(await ensureWsConnectionCurrent(narrowed.connection)).toBe(false);

      const widened = connect();
      widened.current.user = { ...USER, roles: ['editor', 'auditor', 'admin'] };
      expect(await ensureWsConnectionCurrent(widened.connection)).toBe(false);
    });

    it('closes when the verification state changed', async () => {
      setRevalidationMs(0);
      const { connection, current } = connect({ ...USER, verified: true });
      current.user = { ...USER, verified: false };
      expect(await ensureWsConnectionCurrent(connection)).toBe(false);
    });

    it('closes when the credential now resolves to a different user', async () => {
      setRevalidationMs(0);
      const { connection, current } = connect();
      current.user = { ...USER, id: 'user-2' };
      expect(await ensureWsConnectionCurrent(connection)).toBe(false);
    });

    it('ignores the ORDER of roles', async () => {
      setRevalidationMs(0);
      const { connection, current, socket } = connect();
      current.user = { ...USER, roles: ['auditor', 'editor'] };
      expect(await ensureWsConnectionCurrent(connection)).toBe(true);
      expect(socket.close).not.toHaveBeenCalled();
    });

    it('stays refused once terminated, without asking again', async () => {
      setRevalidationMs(0);
      const { connection, current, reauthenticate } = connect();
      current.user = null;
      await ensureWsConnectionCurrent(connection);
      current.user = USER;
      expect(await ensureWsConnectionCurrent(connection)).toBe(false);
      expect(reauthenticate).toHaveBeenCalledTimes(1);
    });

    it('re-resolves the tenant and closes when it no longer resolves the same way', async () => {
      setRevalidationMs(0);
      const resolved = { current: { tenantId: 'tenant-a', tenantRole: 'owner' } as Record<string, any> };
      setTenantContextResolver({ resolve: vi.fn(async () => resolved.current) });
      const { connection, socket } = connect();
      noteWsConnectionTenant(connection, resolved.current);

      expect(await ensureWsConnectionCurrent(connection)).toBe(true);

      resolved.current = { tenantId: 'tenant-a', tenantRole: 'member' };
      expect(await ensureWsConnectionCurrent(connection)).toBe(false);
      expect(socket.close).toHaveBeenCalledWith(WS_AUTHORIZATION_CHANGED_CLOSE_CODE, expect.any(String));
    });

    it('re-checks the tenant even without a re-authentication function', async () => {
      setRevalidationMs(0);
      const resolve = vi.fn(async () => ({}));
      setTenantContextResolver({ resolve });
      const carrier: Record<string, any> = {};
      const socket = new FakeSocket();
      sockets.push(socket);
      registerWsConnection({ carrier, socket, user: USER });
      const connection = getWsConnection(carrier)!;
      noteWsConnectionTenant(connection, { tenantIds: ['tenant-a'] });

      expect(await ensureWsConnectionCurrent(connection)).toBe(false);
      expect(resolve).toHaveBeenCalledWith(USER, undefined);
    });
  });

  describe('noteWsConnectionTenant', () => {
    it('records the first resolution and accepts the same one again', () => {
      const { connection, socket } = connect();
      expect(noteWsConnectionTenant(connection, { tenantIds: ['b', 'a'] })).toBe(true);
      expect(noteWsConnectionTenant(connection, { tenantIds: ['a', 'b'] })).toBe(true);
      expect(socket.close).not.toHaveBeenCalled();
    });

    it('terminates the connection when a later operation resolves a different tenant scope', () => {
      const { connection, socket } = connect();
      noteWsConnectionTenant(connection, { tenantId: 'tenant-a', tenantRole: 'owner' });
      expect(noteWsConnectionTenant(connection, {})).toBe(false);
      expect(socket.close).toHaveBeenCalledWith(WS_AUTHORIZATION_CHANGED_CLOSE_CODE, expect.any(String));
    });
  });

  describe('invalidation', () => {
    it('re-checks the connections of the named user at once, and only those', async () => {
      const anna = connect();
      const ben = connect({ ...USER, email: 'ben@example.com', iamId: 'iam-2', id: 'user-2' });

      expect(revalidateWsConnectionsOf({ userId: 'user-1' })).toBe(1);
      await vi.waitFor(() => expect(anna.reauthenticate).toHaveBeenCalledTimes(1));
      expect(ben.reauthenticate).not.toHaveBeenCalled();
    });

    it('finds a user by IAM id and by e-mail address, case-insensitively', async () => {
      const anna = connect();
      expect(revalidateWsConnectionsOf({ iamId: 'iam-1' })).toBe(1);
      expect(revalidateWsConnectionsOf({ email: 'anna@example.COM' })).toBe(1);
      await vi.waitFor(() => expect(anna.reauthenticate).toHaveBeenCalled());
    });

    it('closes a user connection at once when the invalidation removed its access', async () => {
      const { current, socket } = connect();
      current.user = null;
      revalidateWsConnectionsOf({ userId: 'user-1' });
      await vi.waitFor(() =>
        expect(socket.close).toHaveBeenCalledWith(WS_AUTHORIZATION_CHANGED_CLOSE_CODE, expect.any(String)),
      );
    });

    it('re-checks the connections scoped to a tenant — by tenantId and by tenantIds', async () => {
      const resolve = vi.fn(async () => ({}));
      setTenantContextResolver({ resolve });
      const single = connect();
      noteWsConnectionTenant(single.connection, { tenantId: 'tenant-a' });
      const list = connect();
      noteWsConnectionTenant(list.connection, { tenantIds: ['tenant-b', 'tenant-a'] });
      const other = connect();
      noteWsConnectionTenant(other.connection, { tenantId: 'tenant-c' });

      expect(revalidateWsConnectionsForTenant('tenant-a')).toBe(2);
      await vi.waitFor(() => expect(single.socket.close).toHaveBeenCalled());
      await vi.waitFor(() => expect(list.socket.close).toHaveBeenCalled());
      expect(other.socket.close).not.toHaveBeenCalled();
    });

    it('re-checks every live connection on a full invalidation', async () => {
      const a = connect();
      const b = connect();
      expect(revalidateAllWsConnections()).toBe(2);
      await vi.waitFor(() => expect(a.reauthenticate).toHaveBeenCalled());
      await vi.waitFor(() => expect(b.reauthenticate).toHaveBeenCalled());
    });

    it('re-checks even when the interval is switched off — an invalidation was asked for explicitly', async () => {
      setRevalidationMs(false);
      const { reauthenticate } = connect();
      revalidateWsConnectionsOf({ userId: 'user-1' });
      await vi.waitFor(() => expect(reauthenticate).toHaveBeenCalledTimes(1));
    });

    it('forgets a connection once its socket closed', async () => {
      const { reauthenticate, socket } = connect({ ...USER, id: 'user-closed' });
      socket.emit('close', 1000, 'bye');
      expect(revalidateWsConnectionsOf({ userId: 'user-closed' })).toBe(0);
      expect(reauthenticate).not.toHaveBeenCalled();
    });
  });

  describe('carrier', () => {
    it('survives the shallow copy subscriptions-transport-ws makes of the connection context', () => {
      const { carrier, connection } = connect();
      const perOperationCopy = Object.assign(Object.create(Object.getPrototypeOf(carrier)), carrier);
      expect(getWsConnection(perOperationCopy)).toBe(connection);
    });

    it('cannot be forged through client-supplied JSON', () => {
      const forged = JSON.parse(JSON.stringify({ connection: 'x', wsConnection: {} }));
      expect(getWsConnection(forged)).toBeUndefined();
      expect(getWsConnection(undefined)).toBeUndefined();
    });
  });
});
