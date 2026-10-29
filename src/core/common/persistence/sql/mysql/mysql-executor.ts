import { Logger } from '@nestjs/common';

import type { DatabaseSqlEngine } from '../../../interfaces/server-options.interface.js';
import type { SqlExecutor, SqlStatement, SqlTenantScope, SqlTransaction } from '../sql-executor.interface.js';
import {
  MYSQL_SESSION_SQL,
  mysqlConnectionOptions,
  mysqlResult,
  mysqlStatementParts,
  type MysqlVariant,
  toMysqlStatement,
} from './mysql-session.js';

/**
 * The SQL engine adapters for MySQL 8.4 and MariaDB 11.8 (plan §3.10, phase 6) — the PostgreSQL ones' counterpart.
 *
 * Every engine runs on ONE `mysql2` pool the framework creates, so every connection gets the session of
 * `MYSQL_SESSION_SQL` before its first statement, whichever API sends it: TypeORM receives the pool through its `driver`
 * option, Kysely and Drizzle are handed it directly. The per-operation path is a single autocommitted statement on that
 * pool (no tenant scope travels — neither database has row-level security); engines differ only in how they run a
 * multi-statement transaction and in the native API they hand to projects.
 *
 * `mysql2` is an OPTIONAL peer dependency, loaded on first use, as the engines are.
 */

export interface MysqlExecutorOptions {
  engine: DatabaseSqlEngine;
  /** Pool size. @default 10 */
  maxConnections?: number;
  /** Connection URL (`mysql://` or `mariadb://`, the scheme decides `variant`) */
  url: string;
  variant: MysqlVariant;
}

/** A SQL executor of a MySQL or MariaDB source */
export interface MysqlExecutor extends SqlExecutor {
  readonly variant: MysqlVariant;
}

const logger = new Logger('SqlPool');

export async function createMysqlExecutor(options: MysqlExecutorOptions): Promise<MysqlExecutor> {
  switch (options.engine) {
    case 'drizzle':
      return createDrizzleExecutor(options);
    case 'kysely':
      return createKyselyExecutor(options);
    case 'typeorm':
      return createTypeOrmExecutor(options);
    default:
      throw new Error(`Unknown SQL engine "${String(options.engine)}"`);
  }
}

function missingPeer(name: string): Error {
  return new Error(
    `A MySQL / MariaDB data source is configured but the optional peer dependency "${name}" is not installed. Run: pnpm add ${name}`,
  );
}

async function loadMysql2(): Promise<any> {
  try {
    const module: any = await import('mysql2');
    return module.default ?? module;
  } catch {
    throw missingPeer('mysql2');
  }
}

/**
 * The callback pool every engine shares, with the session applied to each connection the moment it is opened — before
 * any engine can send a statement on it (the driver queues commands per connection in order).
 */
function createPool(mysql2: any, options: MysqlExecutorOptions): any {
  // The URL scheme picks the variant; the driver only understands `mysql://`
  const url = options.url.replace(/^mariadb:/i, 'mysql:');
  const pool = mysql2.createPool(mysqlConnectionOptions(url, options.maxConnections ?? 10));
  pool.on('connection', (connection: any) => {
    connection.query(MYSQL_SESSION_SQL, (error: Error | null) => {
      if (error) {
        // A connection without the session must not serve a statement: it would accept backslash-escaped values the
        // server reads differently. Destroyed, the pool opens the next one
        logger.error(`MySQL session could not be set, connection discarded: ${error.message}`);
        connection.destroy();
      }
    });
  });
  // An idle connection the server closed reports here; without a listener the error would end the process
  pool.on('error', (error: Error) => logger.warn(`MySQL pool error: ${error.message}`));
  return pool;
}

/** Run one statement on the shared pool, autocommitted */
async function runOnPool<R>(promisePool: any, statement: SqlStatement) {
  const { sql, values } = toMysqlStatement(statement);
  const [result] = await promisePool.query(sql, values);
  return mysqlResult<R>(result);
}

/**
 * The `mysql2` error behind an engine's wrapper (TypeORM `QueryFailedError.driverError`, Drizzle's `cause`), so every
 * engine fails with the same error and code as the per-operation path — and Drizzle's message, which prints the
 * parameters, never reaches a log.
 */
function driverErrorOf(error: unknown): unknown {
  const wrapped = (error as { cause?: unknown; driverError?: unknown } | undefined) ?? {};
  for (const inner of [wrapped.driverError, wrapped.cause]) {
    if (inner instanceof Error && typeof (inner as { code?: unknown }).code === 'string') {
      return inner;
    }
  }
  return error;
}

async function unwrapped<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw driverErrorOf(error);
  }
}

// ---------------------------------------------------------------------------------------------
// TypeORM (default)
// ---------------------------------------------------------------------------------------------

async function createTypeOrmExecutor(options: MysqlExecutorOptions): Promise<MysqlExecutor> {
  let typeorm: any;
  try {
    typeorm = await import('typeorm');
  } catch {
    throw missingPeer('typeorm');
  }
  const mysql2 = await loadMysql2();
  const DataSource = typeorm.DataSource ?? typeorm.default?.DataSource;
  let pool: any;
  // TypeORM loads its driver from `options.driver` when given: it gets the framework's pool, session included
  const driver = { ...mysql2, createPool: () => (pool ??= createPool(mysql2, options)) };
  // The framework owns the schema (plan §3.12): TypeORM never synchronizes or runs migrations of its own.
  const dataSource = new DataSource({
    driver,
    entities: [],
    migrationsRun: false,
    synchronize: false,
    timezone: 'Z',
    type: options.variant,
    url: options.url.replace(/^mariadb:/i, 'mysql:'),
  });
  await dataSource.initialize();
  const promisePool = pool.promise();

  return {
    close: () => dataSource.destroy(),
    driverPool: pool,
    engine: 'typeorm',
    native: <N>() => dataSource as N,
    run: <R>(statement: SqlStatement, _scope: SqlTenantScope) => runOnPool<R>(promisePool, statement),
    transaction: async <T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const value = await fn({
          native: <N>() => runner.manager as N,
          run: <R>(statement: SqlStatement) =>
            unwrapped(async () => {
              const { sql, values } = toMysqlStatement(statement);
              const result = await runner.query(sql, values, true);
              return mysqlResult<R>(result.raw ?? result.records);
            }),
        });
        await unwrapped(() => runner.commitTransaction());
        return value;
      } catch (error) {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction().catch(() => undefined);
        }
        throw error;
      } finally {
        await runner.release();
      }
    },
    variant: options.variant,
  };
}

// ---------------------------------------------------------------------------------------------
// Kysely
// ---------------------------------------------------------------------------------------------

async function createKyselyExecutor(options: MysqlExecutorOptions): Promise<MysqlExecutor> {
  let kysely: any;
  try {
    kysely = await import('kysely');
  } catch {
    throw missingPeer('kysely');
  }
  const mysql2 = await loadMysql2();
  const { CompiledQuery, Kysely, MysqlDialect } = kysely;
  const pool = createPool(mysql2, options);
  const db = new Kysely({ dialect: new MysqlDialect({ pool }) });
  const promisePool = pool.promise();

  return {
    close: () => db.destroy(),
    driverPool: pool,
    engine: 'kysely',
    native: <N>() => db as N,
    run: <R>(statement: SqlStatement, _scope: SqlTenantScope) => runOnPool<R>(promisePool, statement),
    transaction: <T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> =>
      db.transaction().execute((trx: any) =>
        fn({
          native: <N>() => trx as N,
          run: async <R>(statement: SqlStatement) => {
            const { sql, values } = toMysqlStatement(statement);
            const result = await trx.executeQuery(CompiledQuery.raw(sql, values));
            const affected = result.numAffectedRows === undefined ? undefined : Number(result.numAffectedRows);
            return affected === undefined
              ? mysqlResult<R>(result.rows)
              : { rowCount: affected, rows: (result.rows ?? []) as R[] };
          },
        }),
      ),
    variant: options.variant,
  };
}

// ---------------------------------------------------------------------------------------------
// Drizzle
// ---------------------------------------------------------------------------------------------

async function createDrizzleExecutor(options: MysqlExecutorOptions): Promise<MysqlExecutor> {
  let drizzleOrm: any;
  let drizzleMysql: any;
  try {
    drizzleOrm = await import('drizzle-orm');
    drizzleMysql = await import('drizzle-orm/mysql2');
  } catch {
    throw missingPeer('drizzle-orm');
  }
  const { sql: drizzleSql } = drizzleOrm;
  const mysql2 = await loadMysql2();
  const pool = createPool(mysql2, options);
  const promisePool = pool.promise();
  const db = drizzleMysql.drizzle({ client: promisePool });

  // The statement as Drizzle SQL with its values bound again: Drizzle's MySQL dialect writes the `?` itself
  const toSql = (statement: SqlStatement) => {
    const { parts, values } = mysqlStatementParts(statement);
    return drizzleSql.join(
      parts.flatMap((part, index) =>
        index ? [drizzleSql.param(values[index - 1]), drizzleSql.raw(part)] : [drizzleSql.raw(part)],
      ),
      drizzleSql.raw(''),
    );
  };

  return {
    close: () => promisePool.end(),
    driverPool: pool,
    engine: 'drizzle',
    native: <N>() => db as N,
    run: <R>(statement: SqlStatement, _scope: SqlTenantScope) => runOnPool<R>(promisePool, statement),
    transaction: <T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> =>
      db
        .transaction((tx: any) =>
          fn({
            native: <N>() => tx as N,
            run: <R>(statement: SqlStatement) =>
              unwrapped(async () => {
                const [result] = await tx.execute(toSql(statement));
                return mysqlResult<R>(result);
              }),
          }),
        )
        .catch((error: unknown) => {
          throw driverErrorOf(error);
        }),
    variant: options.variant,
  };
}
