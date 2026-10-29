import { Logger } from '@nestjs/common';

import type { SqlQueryResult, SqlStatement, SqlTenantScope } from './sql-executor.interface.js';

/**
 * Connection-level safety and the per-statement tenant scope, shared by every SQL engine.
 *
 * Both are framework-owned on purpose: an engine that hands a broken connection back to its pool, or a scope
 * that outlives its transaction, would leak one request's tenant into the next (plan §3.4, A10).
 */

/**
 * Writes the tenant scope into the CURRENT transaction (`is_local = true`): it ends with the transaction and can
 * never reach the next statement on a pooled connection. One statement for all three settings, so applying the
 * scope costs nothing beyond the pipeline it travels in.
 */
export const APPLY_SCOPE_SQL =
  "SELECT set_config('app.tenant_scope', $1, true), set_config('app.tenant_id', $2, true), set_config('app.tenant_ids', $3, true)";

/** The three settings for a scope, in the order of {@link APPLY_SCOPE_SQL}'s parameters. */
export function scopeParams(scope: SqlTenantScope): [string, string, string] {
  switch (scope.kind) {
    case 'system':
      return ['system', '', ''];
    case 'tenant':
      return ['tenant', scope.tenantId, ''];
    case 'tenants':
      return ['tenants', '', JSON.stringify(scope.tenantIds)];
    default:
      return ['none', '', ''];
  }
}

type ErrorListener = (error: Error) => void;

interface PgClientLike {
  _activeQuery?: unknown;
  _queryQueue?: unknown[];
  _sentQueryQueue?: unknown[];
  getTransactionStatus?(): null | string;
  on?(event: 'error', listener: ErrorListener): unknown;
  query(text: string, params?: readonly unknown[]): Promise<{ rowCount: null | number; rows: any[] }>;
  release(error?: Error | boolean): void;
  removeListener?(event: 'error', listener: ErrorListener): unknown;
}

interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  connect(
    callback: (error: Error | undefined, client: PgClientLike, release: (error?: Error | boolean) => void) => void,
  ): void;
  listenerCount?(event: 'error'): number;
  on?(event: 'error', listener: ErrorListener): unknown;
}

const poolLogger = new Logger('SqlPool');
const guardedPools = new WeakSet<object>();

/** Whether {@link guardPool} protects `pool`. */
export function isGuardedPool(pool: unknown): boolean {
  return typeof pool === 'object' && pool !== null && guardedPools.has(pool);
}

/**
 * Make a node-postgres pool destroy every connection that is handed back inside a transaction, with a query still
 * in flight, or after it died, instead of re-using it — and keep a dying connection from ending the process.
 *
 * Measured (A10): after a client-side query timeout TypeORM 1.1 released broken connections (the pool then hung)
 * and Kysely 0.29 released a connection still inside the dead transaction — the next request read the previous
 * request's tenant. pg-pool binds `client.release` after emitting `acquire`, so the guard wraps `connect` and covers
 * both the promise form (Kysely, Drizzle, the framework) and the callback form (TypeORM).
 *
 * "In flight" is node-postgres' own busy test: an active query, or one queued or already sent — on a pipelined
 * client the sent ones wait in `_sentQueryQueue`, not in `_activeQuery`.
 *
 * pg-pool listens for `error` only on IDLE connections. A connection that dies while checked out — terminated by
 * the server, or destroyed by node-postgres itself when a pipelined query times out — emits `error` with nobody
 * listening, and Node ends the process on an unhandled `error` event. The guard listens for the whole checkout and
 * hands that error to the release, so the pool destroys the connection. An IDLE connection's error is re-emitted
 * by the pool, which is just as fatal without a listener: Kysely and Drizzle attach none (TypeORM does, and keeps
 * its own), so the guard adds one where nobody listens.
 */
export function guardPool<P>(pool: P): P {
  const target = pool as unknown as PgPoolLike;
  if (guardedPools.has(target)) {
    return pool;
  }
  const connect = target.connect.bind(target) as (...args: any[]) => any;
  const unhealthy = (client: PgClientLike): Error | undefined =>
    (client.getTransactionStatus?.() ?? 'I') !== 'I' ||
    client._activeQuery ||
    client._sentQueryQueue?.length ||
    client._queryQueue?.length
      ? new Error('released inside a transaction or with a query in flight')
      : undefined;
  const wrap = (client: PgClientLike) => {
    const release = client.release.bind(client);
    let died: Error | undefined;
    const onError: ErrorListener = (error) => {
      died = error;
    };
    client.on?.('error', onError);
    client.release = (error?: Error | boolean) => {
      client.removeListener?.('error', onError);
      return release(error ?? died ?? unhealthy(client));
    };
    return client.release;
  };
  (target as any).connect = (callback?: (...args: any[]) => void) =>
    typeof callback === 'function'
      ? connect((error: Error | undefined, client: PgClientLike, release: any) =>
          callback(error, client, error ? release : wrap(client)),
        )
      : connect().then((client: PgClientLike) => {
          wrap(client);
          return client;
        });
  if (!target.listenerCount?.('error')) {
    target.on?.('error', (error) =>
      poolLogger.warn(`An idle database connection failed and was removed from the pool: ${error.message}`),
    );
  }
  guardedPools.add(target);
  return pool;
}

/**
 * Run ONE statement in its own transaction with `scope` applied: `BEGIN` · scope · statement · `COMMIT`, pipelined
 * into a single round trip on a pool created with `pipeline: true` (plan §3.8, A13).
 *
 * Every step is awaited before the connection goes back, so the pool never receives a connection mid-pipeline. A
 * failed statement aborts the transaction; Postgres then answers the `COMMIT` with a rollback, and the statement's
 * own error is what the caller sees.
 */
export async function runInOwnTransaction<R>(
  pool: unknown,
  statement: SqlStatement,
  scope: SqlTenantScope,
): Promise<SqlQueryResult<R>> {
  const client = await (pool as PgPoolLike).connect();
  try {
    const [begin, applied, result, commit] = await Promise.allSettled([
      client.query('BEGIN'),
      client.query(APPLY_SCOPE_SQL, scopeParams(scope)),
      client.query(statement.text, statement.params),
      client.query('COMMIT'),
    ]);
    for (const step of [begin, applied, result, commit]) {
      if (step.status === 'rejected') {
        throw step.reason;
      }
    }
    const value = (result as PromiseFulfilledResult<{ rowCount: null | number; rows: R[] }>).value;
    return { rowCount: value.rowCount ?? value.rows.length, rows: value.rows };
  } finally {
    client.release();
  }
}
