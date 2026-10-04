import { Logger } from '@nestjs/common';

import { ConfigService } from '../services/config.service';
import { getTenantContextResolver, ResolvedTenantContext } from '../services/core-tenant-context.registry';

/**
 * The authorization lifecycle of an OPEN GraphQL WebSocket connection.
 *
 * WHY THIS EXISTS: a WebSocket is authorized at the handshake. `onConnect` validates the session and
 * records the user; the subscribe wrapper (`graphql-ws-context.helper.ts`) resolves the tenant. Before
 * 11.42.3 nothing ever looked again — every delivered event and every further operation on the socket
 * ran on that snapshot. Removing somebody from a tenant, switching a tenant off, withdrawing a role or
 * ending a session therefore took effect on every NEW request and on none of the sockets that were
 * already open, for as long as the client kept them open. For a browser tab that is hours.
 *
 * WHAT IT DOES: each connection is registered with the rights it was authorized with — the user's id,
 * roles and verification state, and the tenant scope its operations resolved — plus a function that
 * re-runs the handshake's authentication. Those rights are checked again
 *
 *  - when an INVALIDATION names the connection (`revalidateWsConnectionsOf()` from a membership or
 *    role change, `revalidateWsConnectionsForTenant()` from a tenant switch, a password reset), at
 *    once and before any further event, and
 *  - before an event is delivered or an operation runs, once the last check is older than
 *    `graphQl.subscriptionRevalidationMs` (default 30 s) — the bound for a change nobody invalidated,
 *    such as a session that was signed out or a membership edited directly in the database.
 *
 * A connection whose rights CHANGED — narrowed or widened — is closed with 4403. It is not patched in
 * place, deliberately: a subscription may have chosen its topic or its filter from the tenant at
 * subscribe time, and only a fresh subscribe re-derives that. The graphql-ws client RETRIES 4403 (its
 * own comment: "might grant access after retry"), so the user reconnects and continues with the
 * rights they hold now, or is refused at `onConnect` if the session is gone.
 *
 * WHAT IT DOES NOT DO: an event is checked AFTER graphql-js executed it and BEFORE it is sent. Reads
 * made while computing a dropped event still happened — under the old context — but nothing of them
 * reaches the client. Subscription resolvers that WRITE are outside what this can take back.
 */

/**
 * Close code for a connection whose authorization changed: graphql-ws's `CloseCode.Forbidden`. Its
 * client retries it, which is what makes the close a re-authorization rather than a hang-up.
 */
export const WS_AUTHORIZATION_CHANGED_CLOSE_CODE = 4403;

/** Default for `graphQl.subscriptionRevalidationMs`. */
export const DEFAULT_SUBSCRIPTION_REVALIDATION_MS = 30_000;

/** The parts of a socket this helper needs: closing it, and noticing that it closed. */
export interface IWsConnectionSocket {
  close(code: number, reason?: string): void;
  once?(event: 'close', listener: (...args: any[]) => void): unknown;
}

export interface IWsConnectionRegistration {
  /**
   * The object every operation of the connection receives as its GraphQL context: `extra` for
   * graphql-ws, the object `onConnect` returns for subscriptions-transport-ws (which copies it per
   * operation — the registration survives that copy).
   */
  carrier: object;

  /**
   * Re-run the handshake's authentication. Resolves to the user the credential authenticates as NOW,
   * or to a falsy value when it no longer does. A rejection counts as falsy. Without it only the
   * tenant scope is re-checked.
   */
  reauthenticate?: () => any;

  /** The raw socket — closed when the rights changed, and watched so a closed connection is forgotten. */
  socket?: IWsConnectionSocket;

  /** The user the handshake authenticated. */
  user: any;
}

/** Who an invalidation is about. Any one field is enough; `userId` is the `users` document id. */
export interface IWsConnectionIdentity {
  email?: string;
  iamId?: string;
  userId?: string;
}

/** @internal The registered state of one connection. */
export interface WsConnection {
  readonly email?: string;
  readonly iamId?: string;
  readonly reauthenticate?: () => any;
  readonly socket?: IWsConnectionSocket;
  /** The tenant scope the connection's operations resolved, once one has. */
  tenant?: ResolvedTenantContext;
  /** The tenant header the client sent — constant for the life of the connection. */
  readonly tenantHeader?: string;
  terminated: boolean;
  readonly user: any;
  readonly userFingerprint: string;
  readonly userId?: string;
  /** @internal */
  inflight?: Promise<boolean>;
  /** @internal */
  stale: boolean;
  /** @internal */
  tenantFingerprint?: string;
  /** @internal */
  validatedAt: number;
}

/**
 * Module-private and not `Symbol.for()`: nothing a client sends — `connectionParams` are JSON — can
 * produce it, so a registration cannot be forged or overwritten from outside. Enumerable on purpose:
 * subscriptions-transport-ws hands each operation an `Object.assign` copy of the connection context,
 * and only enumerable own properties survive that.
 */
const WS_CONNECTION = Symbol('ltWsConnection');

/**
 * Connections that can be found by an invalidation. Only those with a socket to watch: without a
 * `close` event there is no moment to forget them, and a registry that only grows is a leak. A
 * connection without one is still re-checked by the interval, through its carrier.
 */
const liveConnections = new Set<WsConnection>();

const logger = new Logger('GraphQlWsConnection');

/**
 * Resolve `graphQl.subscriptionRevalidationMs` to an interval, or `false` for "off".
 *
 * Only an explicit `false` switches the interval off. Anything else that is not a usable interval
 * falls back to the DEFAULT, never to "off": this bounds how long revoked access keeps flowing, and a
 * typo in an environment variable must not be the thing that removes the bound. `0` is a legitimate
 * value meaning "on every operation and every event".
 */
export function resolveSubscriptionRevalidationMs(value: unknown): false | number {
  if (value === false || value === 'false') {
    return false;
  }
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }
  return DEFAULT_SUBSCRIPTION_REVALIDATION_MS;
}

function configuredRevalidationMs(): false | number {
  const graphQl = ConfigService.configFastButReadOnly?.graphQl;
  return resolveSubscriptionRevalidationMs(graphQl ? graphQl.subscriptionRevalidationMs : undefined);
}

/** What a connection's rights depend on, as a comparable string. Role ORDER does not count. */
function fingerprintUser(user: any): string {
  if (!user) {
    return '';
  }
  const roles = Array.isArray(user.roles) ? user.roles.map((role: unknown) => String(role)).sort() : [];
  const verified = !!(user.verified || user.verifiedAt || user.emailVerified);
  return JSON.stringify([String(user.id ?? user._id ?? ''), roles, verified]);
}

function fingerprintTenant(tenant: ResolvedTenantContext | undefined): string {
  const tenantIds = Array.isArray(tenant?.tenantIds) ? tenant.tenantIds.map((id) => String(id)).sort() : null;
  return JSON.stringify([tenant?.tenantId ?? null, tenantIds, tenant?.tenantRole ?? null, !!tenant?.isAdminBypass]);
}

/** Same lookup the context wrapper uses — see `readTenantHeader()` in graphql-ws-context.helper.ts. */
export function readWsTenantHeader(contextValue: any): string | undefined {
  const headerName = (ConfigService.configFastButReadOnly?.multiTenancy?.headerName ?? 'x-tenant-id').toLowerCase();
  const sources = [contextValue?.headers, contextValue?.connectionParams, contextValue?.request?.headers];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (key.toLowerCase() === headerName && typeof value === 'string' && value) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Register a connection after a successful handshake. Call it from `onConnect`, with the same user
 * the handshake recorded on the carrier.
 */
export function registerWsConnection(registration: IWsConnectionRegistration): void {
  const { carrier, reauthenticate, socket, user } = registration;
  if (!carrier || typeof carrier !== 'object') {
    return;
  }
  const userId = user?.id ?? user?._id;
  const connection: WsConnection = {
    email: typeof user?.email === 'string' ? user.email.toLowerCase() : undefined,
    iamId: typeof user?.iamId === 'string' ? user.iamId : undefined,
    reauthenticate,
    socket,
    stale: false,
    tenantHeader: readWsTenantHeader(carrier),
    terminated: false,
    user,
    userFingerprint: fingerprintUser(user),
    userId: userId !== undefined && userId !== null ? String(userId) : undefined,
    validatedAt: Date.now(),
  };
  Object.defineProperty(carrier, WS_CONNECTION, { configurable: true, enumerable: true, value: connection });

  if (socket && typeof socket.once === 'function') {
    liveConnections.add(connection);
    socket.once('close', () => {
      connection.terminated = true;
      liveConnections.delete(connection);
    });
  }
}

/** The registered connection a GraphQL context belongs to, if any. */
export function getWsConnection(contextValue: any): undefined | WsConnection {
  if (!contextValue || typeof contextValue !== 'object') {
    return undefined;
  }
  const connection = contextValue[WS_CONNECTION];
  return connection && typeof connection === 'object' ? connection : undefined;
}

/**
 * Close a connection whose authorization no longer holds. Idempotent; always answers `false` so a
 * caller can `return terminate(...)`.
 */
function terminate(connection: WsConnection, reason: string): false {
  if (connection.terminated) {
    return false;
  }
  connection.terminated = true;
  liveConnections.delete(connection);
  logger.log(`Closing GraphQL WebSocket of user ${connection.userId ?? '(unknown)'}: ${reason}`);
  try {
    // A close reason is limited to 123 bytes on the wire; these are short and ASCII.
    connection.socket?.close(WS_AUTHORIZATION_CHANGED_CLOSE_CODE, reason);
  } catch {
    // Already closing — the outcome is the same.
  }
  return false;
}

async function revalidate(connection: WsConnection): Promise<boolean> {
  connection.stale = false;
  try {
    let user = connection.user;
    if (connection.reauthenticate) {
      user = await connection.reauthenticate();
      if (!user) {
        return terminate(connection, 'Session no longer valid');
      }
    }
    if (fingerprintUser(user) !== connection.userFingerprint) {
      return terminate(connection, 'User authorization changed');
    }
    if (connection.tenantFingerprint !== undefined) {
      const resolver = getTenantContextResolver();
      const tenant = resolver ? await resolver.resolve(user, connection.tenantHeader) : {};
      if (fingerprintTenant(tenant) !== connection.tenantFingerprint) {
        return terminate(connection, 'Tenant access changed');
      }
    }
    if (connection.terminated) {
      return false;
    }
    connection.validatedAt = Date.now();
    return true;
  } catch {
    // Fail closed: a check that cannot be made is not a check that passed. The client reconnects,
    // and the handshake decides again.
    return terminate(connection, 'Authorization check failed');
  }
}

/**
 * Is the connection still authorized as it was registered? Re-checks when an invalidation marked it,
 * or when its last check is older than `graphQl.subscriptionRevalidationMs`; otherwise answers from
 * the last check without any I/O. Concurrent callers share one re-check.
 *
 * `false` means the connection has been closed and nothing more may be delivered or executed on it.
 */
export function ensureWsConnectionCurrent(connection: WsConnection): Promise<boolean> {
  if (connection.terminated) {
    return Promise.resolve(false);
  }
  const interval = configuredRevalidationMs();
  if (!connection.stale && (interval === false || Date.now() - connection.validatedAt < interval)) {
    return Promise.resolve(true);
  }
  if (!connection.inflight) {
    connection.inflight = revalidate(connection).finally(() => {
      connection.inflight = undefined;
      // An invalidation that arrived while this check was running may have been answered from data
      // that predates it — check once more rather than lose it.
      if (connection.stale && !connection.terminated) {
        void ensureWsConnectionCurrent(connection);
      }
    });
  }
  return connection.inflight;
}

/**
 * Record the tenant scope an operation on this connection resolved.
 *
 * The first resolution becomes the connection's scope. A later operation resolving a DIFFERENT one
 * means the rights changed underneath the subscriptions that are already running on the old scope —
 * the connection is closed, and `false` returned.
 */
export function noteWsConnectionTenant(connection: WsConnection, tenant: ResolvedTenantContext | undefined): boolean {
  if (connection.terminated) {
    return false;
  }
  const fingerprint = fingerprintTenant(tenant);
  if (connection.tenantFingerprint === undefined) {
    connection.tenant = tenant ? { ...tenant } : {};
    connection.tenantFingerprint = fingerprint;
    return true;
  }
  if (fingerprint !== connection.tenantFingerprint) {
    return terminate(connection, 'Tenant access changed');
  }
  return true;
}

/** Mark a connection for an immediate re-check and start it. */
function markStale(connection: WsConnection): void {
  connection.stale = true;
  void ensureWsConnectionCurrent(connection);
}

/**
 * Re-check, at once, every open connection of a user — after a membership, role or credential change.
 * Answers the number of connections affected. Process-local: the tenant guard's Redis broadcast is
 * what carries a membership invalidation to the other replicas.
 */
export function revalidateWsConnectionsOf(identity: IWsConnectionIdentity): number {
  const userId = identity?.userId !== undefined && identity?.userId !== null ? String(identity.userId) : undefined;
  const iamId = identity?.iamId || undefined;
  const email = typeof identity?.email === 'string' ? identity.email.toLowerCase() : undefined;
  if (!userId && !iamId && !email) {
    return 0;
  }
  let count = 0;
  for (const connection of liveConnections) {
    if (
      (userId && connection.userId === userId) ||
      (iamId && connection.iamId === iamId) ||
      (email && connection.email === email)
    ) {
      markStale(connection);
      count++;
    }
  }
  return count;
}

/** Re-check, at once, every open connection scoped to a tenant — after the tenant was switched on or off. */
export function revalidateWsConnectionsForTenant(tenantId: string): number {
  if (!tenantId) {
    return 0;
  }
  const id = String(tenantId);
  let count = 0;
  for (const connection of liveConnections) {
    const tenant = connection.tenant;
    if (tenant && (tenant.tenantId === id || (Array.isArray(tenant.tenantIds) && tenant.tenantIds.includes(id)))) {
      markStale(connection);
      count++;
    }
  }
  return count;
}

/** Re-check every open connection — after a change whose reach is unknown (`invalidateAll()`). */
export function revalidateAllWsConnections(): number {
  let count = 0;
  for (const connection of liveConnections) {
    markStale(connection);
    count++;
  }
  return count;
}
