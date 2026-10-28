import type { DatabaseSqlEngine } from '../../interfaces/server-options.interface.js';
import type {
  SqlExecutor,
  SqlQueryResult,
  SqlStatement,
  SqlTenantScope,
  SqlTransaction,
} from './sql-executor.interface.js';
import { createMysqlExecutor } from './mysql/mysql-executor.js';
import { APPLY_SCOPE_SQL, guardPool, runInOwnTransaction, scopeParams } from './sql-session.js';

/**
 * The SQL engine adapters (plan §3.10). The per-operation path is identical for every engine — node-postgres,
 * pipelined, on a guarded pool — so switching the engine cannot change what a store operation does. Engines
 * differ only in how they run a multi-statement transaction and in the native API they hand to projects.
 *
 * Every engine is an OPTIONAL peer dependency and loaded on first use (`import()` with a literal specifier: these
 * are dual packages, so they are loaded lazily everywhere — see `.claude/rules/architecture.md`).
 */

export interface SqlExecutorOptions {
  /** Shown as `application_name` in `pg_stat_activity`. */
  applicationName?: string;
  engine: DatabaseSqlEngine;
  /** Pool size. @default 10 */
  maxConnections?: number;
  /** Client-side statement timeout in milliseconds (node-postgres `query_timeout`). @default none */
  queryTimeoutMs?: number;
  /** Connection URL of the APPLICATION role */
  url: string;
}

export async function createSqlExecutor(options: SqlExecutorOptions): Promise<SqlExecutor> {
  // The URL's scheme picks the dialect: MySQL and MariaDB have adapters of their own (phase 6)
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(options.url)?.[1]?.toLowerCase();
  if (scheme === 'mysql' || scheme === 'mariadb') {
    return createMysqlExecutor({
      engine: options.engine,
      maxConnections: options.maxConnections,
      url: options.url,
      variant: scheme,
    });
  }
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

/**
 * The first SQL engine the project has installed, in the framework's order (`typeorm`, `kysely`, `drizzle`) — for a
 * caller that runs outside the application and has no `database.sqlEngine` to read, such as the migrate CLI. A project
 * installs only the engine it chose, so assuming the default there would fail every call of a project on another one.
 */
export async function installedSqlEngine(): Promise<DatabaseSqlEngine> {
  const candidates: [DatabaseSqlEngine, () => Promise<unknown>][] = [
    ['typeorm', () => import('typeorm')],
    ['kysely', () => import('kysely')],
    ['drizzle', () => import('drizzle-orm')],
  ];
  for (const [engine, load] of candidates) {
    try {
      await load();
      return engine;
    } catch {
      // Not installed — try the next one
    }
  }
  throw new Error(
    'A SQL connection needs one of the optional SQL engines, none is installed. Run: pnpm add typeorm pg ' +
      '(PostgreSQL) or pnpm add typeorm mysql2 (MySQL / MariaDB)',
  );
}

function missingPeer(name: string): Error {
  return new Error(
    `A SQL data source is configured but the optional peer dependency "${name}" is not installed. Run: pnpm add ${name}`,
  );
}

/** Pool options shared by every engine: pipelining for the per-operation path, the guard against poisoned clients. */
function poolOptions(options: SqlExecutorOptions): Record<string, unknown> {
  return {
    max: options.maxConnections ?? 10,
    pipeline: true,
    ...(options.applicationName ? { application_name: options.applicationName } : {}),
    ...(options.queryTimeoutMs ? { query_timeout: options.queryTimeoutMs } : {}),
  };
}

/**
 * The node-postgres error behind an engine's wrapper (TypeORM `QueryFailedError.driverError`, Drizzle
 * `DrizzleQueryError.cause`), so every engine fails with the same error and SQLSTATE as the per-operation path. It
 * also keeps the statement's parameters out of the message: Drizzle's wrapper prints them.
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

/** Run `step`, rethrowing an engine's wrapped error as the driver error underneath. */
async function unwrapped<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw driverErrorOf(error);
  }
}

async function createPgPool(options: SqlExecutorOptions): Promise<any> {
  let pg: any;
  try {
    pg = await import('pg');
  } catch {
    throw missingPeer('pg');
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  return guardPool(new Pool({ connectionString: options.url, ...poolOptions(options) }));
}

function resultOf<R>(rows: R[] | undefined, rowCount: null | number | undefined): SqlQueryResult<R> {
  const list = rows ?? [];
  return { rowCount: typeof rowCount === 'number' ? rowCount : list.length, rows: list };
}

// ---------------------------------------------------------------------------------------------
// TypeORM (default)
// ---------------------------------------------------------------------------------------------

async function createTypeOrmExecutor(options: SqlExecutorOptions): Promise<SqlExecutor> {
  let typeorm: any;
  try {
    typeorm = await import('typeorm');
  } catch {
    throw missingPeer('typeorm');
  }
  const DataSource = typeorm.DataSource ?? typeorm.default?.DataSource;
  // The framework owns the schema (plan §3.12): TypeORM never synchronizes or runs migrations of its own.
  const dataSource = new DataSource({
    entities: [],
    extra: poolOptions(options),
    migrationsRun: false,
    synchronize: false,
    type: 'postgres',
    url: options.url,
  });
  await dataSource.initialize();
  const pool = guardPool(dataSource.driver.master);

  return {
    close: () => dataSource.destroy(),
    driverPool: pool,
    engine: 'typeorm',
    native: <N>() => dataSource as N,
    run: <R>(statement: SqlStatement, scope: SqlTenantScope) => runInOwnTransaction<R>(pool, statement, scope),
    transaction: async <T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const value = await fn({
          native: <N>() => runner.manager as N,
          run: <R>(statement: SqlStatement, scope: SqlTenantScope) =>
            unwrapped(async () => {
              await runner.query(APPLY_SCOPE_SQL, scopeParams(scope));
              const result = await runner.query(statement.text, [...statement.params], true);
              return resultOf<R>(result.records, result.affected);
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
  };
}

// ---------------------------------------------------------------------------------------------
// Kysely
// ---------------------------------------------------------------------------------------------

async function createKyselyExecutor(options: SqlExecutorOptions): Promise<SqlExecutor> {
  let kysely: any;
  try {
    kysely = await import('kysely');
  } catch {
    throw missingPeer('kysely');
  }
  const { CompiledQuery, Kysely, PostgresDialect } = kysely;
  const pool = await createPgPool(options);
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

  return {
    close: () => db.destroy(),
    driverPool: pool,
    engine: 'kysely',
    native: <N>() => db as N,
    run: <R>(statement: SqlStatement, scope: SqlTenantScope) => runInOwnTransaction<R>(pool, statement, scope),
    transaction: <T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> =>
      db.transaction().execute((trx: any) =>
        fn({
          native: <N>() => trx as N,
          run: async <R>(statement: SqlStatement, scope: SqlTenantScope) => {
            await trx.executeQuery(CompiledQuery.raw(APPLY_SCOPE_SQL, scopeParams(scope)));
            const result = await trx.executeQuery(CompiledQuery.raw(statement.text, [...statement.params]));
            const affected = result.numAffectedRows === undefined ? undefined : Number(result.numAffectedRows);
            return resultOf<R>(result.rows, affected);
          },
        }),
      ),
  };
}

// ---------------------------------------------------------------------------------------------
// Drizzle
// ---------------------------------------------------------------------------------------------

async function createDrizzleExecutor(options: SqlExecutorOptions): Promise<SqlExecutor> {
  let drizzleOrm: any;
  let drizzlePg: any;
  try {
    drizzleOrm = await import('drizzle-orm');
    drizzlePg = await import('drizzle-orm/node-postgres');
  } catch {
    throw missingPeer('drizzle-orm');
  }
  const { sql } = drizzleOrm;
  const pool = await createPgPool(options);
  const db = drizzlePg.drizzle({ client: pool });

  // Positional statement → Drizzle SQL with the values bound as parameters again. Only `$<digits>` placeholders
  // are split, and the framework's compilers never emit one inside a literal. `sql.param()`, not `sql\`${value}\``:
  // the template expands an array into a list of parameters, which turns a `text[]` into a row.
  const toSql = (text: string, params: readonly unknown[]) =>
    sql.join(
      text.split(/\$(\d+)/).map((part, index) => (index % 2 ? sql.param(params[Number(part) - 1]) : sql.raw(part))),
      sql.raw(''),
    );

  return {
    close: () => pool.end(),
    driverPool: pool,
    engine: 'drizzle',
    native: <N>() => db as N,
    run: <R>(statement: SqlStatement, scope: SqlTenantScope) => runInOwnTransaction<R>(pool, statement, scope),
    // Drizzle runs the COMMIT inside `db.transaction()`; only that statement's wrapper is unwrapped here, an error
    // `fn` raised through Drizzle's own API stays Drizzle's.
    transaction: <T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> =>
      db
        .transaction((tx: any) =>
          fn({
            native: <N>() => tx as N,
            run: <R>(statement: SqlStatement, scope: SqlTenantScope) =>
              unwrapped(async () => {
                await tx.execute(toSql(APPLY_SCOPE_SQL, scopeParams(scope)));
                const result = await tx.execute(toSql(statement.text, statement.params));
                return resultOf<R>(result.rows, result.rowCount);
              }),
          }),
        )
        .catch((error: unknown) => {
          throw (error as { query?: unknown })?.query === 'commit' ? driverErrorOf(error) : error;
        }),
  };
}
