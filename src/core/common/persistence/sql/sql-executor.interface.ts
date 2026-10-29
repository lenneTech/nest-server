/**
 * The SQL executor port: what the framework needs from a SQL engine (plan §3.10).
 *
 * The framework compiles every statement, policy and schema change itself; an engine only executes and
 * offers its own API for native access. Import-free on purpose (types only).
 */
import type { DatabaseSqlEngine } from '../../interfaces/server-options.interface.js';

/**
 * The tenant scope of ONE statement, written into the transaction with `set_config(…, true)` and read by the
 * RLS guard function (plan §3.4, §3.8).
 *
 * - `system`: no tenant filter (system work, `runWithBypassTenantGuard()`, or a platform admin without tenant)
 * - `tenant`: exactly `tenantId`
 * - `tenants`: any of `tenantIds` (header-less read of a member)
 * - `none`: no valid tenant context — the guard function refuses every tenant-scoped row (42501)
 */
export type SqlTenantScope =
  | { kind: 'none' }
  | { kind: 'system' }
  | { kind: 'tenant'; tenantId: string }
  | { kind: 'tenants'; tenantIds: readonly string[] };

export interface SqlQueryResult<R = Record<string, any>> {
  rowCount: number;
  rows: R[];
}

/** A statement and its positional parameters (`$1`, `$2`, …). */
export interface SqlStatement {
  params: readonly unknown[];
  text: string;
}

/** Statements inside one transaction, on one connection. */
export interface SqlTransaction {
  /** The engine's own API, bound to this transaction's connection. */
  native<N = unknown>(): N;
  /** Run a statement after applying `scope` to the transaction. */
  run<R = Record<string, any>>(statement: SqlStatement, scope: SqlTenantScope): Promise<SqlQueryResult<R>>;
}

export interface SqlExecutor {
  close(): Promise<void>;
  /**
   * The driver's pool the executor runs on (node-postgres, or `mysql2`'s callback pool) — a library with its own adapter
   * (Better-Auth) receives what it can run on through `SqlDialect.foreignPool()`.
   */
  readonly driverPool: unknown;
  readonly engine: DatabaseSqlEngine;
  /** The engine's own API, outside any framework transaction. */
  native<N = unknown>(): N;
  /**
   * Run ONE statement in its own transaction with `scope` applied — `BEGIN`, `set_config`, statement, `COMMIT`
   * pipelined into a single round trip (plan §3.8, A13).
   */
  run<R = Record<string, any>>(statement: SqlStatement, scope: SqlTenantScope): Promise<SqlQueryResult<R>>;
  /** Several statements in one transaction, on one connection; rolled back when `fn` throws. */
  transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>;
}
