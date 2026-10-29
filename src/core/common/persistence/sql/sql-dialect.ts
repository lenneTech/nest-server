import type { LockStore } from '../lock-store.interface.js';
import type { ModelDescriptor } from '../model-descriptor.interface.js';
import { MysqlDataStore } from './mysql/mysql-data-store.js';
import type { MysqlExecutor } from './mysql/mysql-executor.js';
import { MysqlLockStore } from './mysql/mysql-lock-store.js';
import {
  applyMysqlSchema,
  assertSafeMysqlApplicationAccount,
  type MysqlSchemaOptions,
  mysqlAccount,
  anyTableMissing,
  verifyMysqlSchema,
  withFrameworkDefaultCollation,
  withMysqlSchemaLock,
} from './mysql/mysql-schema.migrator.js';
import type { MysqlVariant } from './mysql/mysql-session.js';
import { PostgresLockStore } from './postgres/postgres-lock-store.js';
import { grantStatement, type PostgresSchemaOptions } from './postgres/postgres-schema.compiler.js';
import {
  applyPostgresSchema,
  assertSafeApplicationRole,
  SCHEMA_LOCK_SQL,
  verifyPostgresSchema,
} from './postgres/postgres-schema.migrator.js';
import { SqlDataStore, type SqlDataStoreOptions } from './sql-data-store.js';
import type { SqlExecutor } from './sql-executor.interface.js';
import type { SchemaChange } from './sql-schema.shared.js';

/**
 * What differs between the SQL databases at the level of a data source: how its schema is brought up to date, which
 * application role it accepts, and which store and lease implementation serve it. The runtime asks the dialect and
 * never the driver name.
 */
export interface SqlDialect {
  /** Shown in boot logs: `PostgreSQL`, `MySQL`, `MariaDB` */
  readonly label: string;
  /** Apply every automatic change as the OWNER (one locked run); refuses when a migration is needed */
  applySchema(owner: SqlExecutor, app: SqlExecutor, models: ModelDescriptor[]): Promise<SchemaChange[]>;
  /** Refuse an application role the database's protections cannot bind */
  assertSafeApplication(app: SqlExecutor, tables: string[]): Promise<void>;
  createLockStore(app: SqlExecutor): LockStore;
  createStore(app: SqlExecutor, model: ModelDescriptor, options: SqlDataStoreOptions): SqlDataStore<any>;
  /**
   * What a library with its own database adapter runs on (Better-Auth's Kysely adapter): the `pg` pool on PostgreSQL; on
   * MySQL / MariaDB the `mysql2` pool's promise wrapper — Better-Auth recognises a MySQL pool by `getConnection`, and
   * Kysely's `MysqlDialect` reads the callback pool it needs from the wrapper's `pool` field. The same connections, so
   * the library's statements run in the session the framework set up.
   */
  foreignPool(executor: SqlExecutor): unknown;
  /** How a tenant-isolated model's rows are protected, for the boot log */
  isolation(isolated: boolean): string;
  /** Without an owner connection: only check, and refuse to start on any pending change */
  verifySchema(app: SqlExecutor, models: ModelDescriptor[]): Promise<SchemaChange[]>;
  /**
   * Run `migrate` — the schema run of a library that owns tables of its own (Better-Auth), as the owner — while `lock`
   * holds the framework's schema lock, and leave the application role the rights on `tables` the framework's tables
   * give it
   */
  withForeignSchemaLock(lock: SqlExecutor, tables: string[], migrate: () => Promise<void>): Promise<void>;
}

const SYSTEM = { kind: 'system' } as const;

export interface SqlDialectContext {
  /** The application role as the connection URL names it */
  appRole: string;
  driver: 'mariadb' | 'mysql' | 'postgres';
  isTenantIsolated: (model: ModelDescriptor) => boolean;
}

export function sqlDialect(context: SqlDialectContext): SqlDialect {
  return context.driver === 'postgres' ? postgresDialect(context) : mysqlDialect(context.driver);
}

function postgresDialect(context: SqlDialectContext): SqlDialect {
  const options: PostgresSchemaOptions = { appRole: context.appRole, isTenantIsolated: context.isTenantIsolated };
  return {
    applySchema: (owner, _app, models) => applyPostgresSchema(owner, models, options),
    assertSafeApplication: (app, tables) => assertSafeApplicationRole(app, tables),
    createLockStore: (app) => new PostgresLockStore(app),
    createStore: (app, model, storeOptions) => new SqlDataStore<any>(app, model, storeOptions),
    foreignPool: (executor) => executor.driverPool,
    isolation: (isolated) => (isolated ? ' (row-level security)' : ''),
    label: 'PostgreSQL',
    verifySchema: (app, models) => verifyPostgresSchema(app, models, options),
    withForeignSchemaLock: (lock, tables, migrate) =>
      lock.transaction(async (tx) => {
        await tx.run({ params: [], text: SCHEMA_LOCK_SQL }, SYSTEM);
        await migrate();
        for (const table of tables) {
          await tx.run({ params: [], text: grantStatement(table, context.appRole) }, SYSTEM);
        }
      }),
  };
}

function mysqlDialect(variant: MysqlVariant): SqlDialect {
  let account: Promise<string> | undefined;
  // The account as the server matched it (`'user'@'host'`) — the name a grant needs, not the URL's user alone
  const options = async (app: SqlExecutor): Promise<MysqlSchemaOptions> => {
    account ??= mysqlAccount(app);
    return { appAccount: await account, variant };
  };
  return {
    applySchema: async (owner, app, models) => applyMysqlSchema(owner, models, await options(app)),
    assertSafeApplication: (app) => assertSafeMysqlApplicationAccount(app, variant),
    createLockStore: (app) => new MysqlLockStore(app),
    createStore: (app, model, storeOptions) => new MysqlDataStore<any>(app as MysqlExecutor, model, storeOptions),
    foreignPool: (executor) => (executor.driverPool as { promise(): unknown }).promise(),
    isolation: (isolated) => (isolated ? ' (tenant isolation in the application only)' : ''),
    label: variant === 'mysql' ? 'MySQL' : 'MariaDB',
    verifySchema: async (app, models) => verifyMysqlSchema(app, models, await options(app)),
    // The application account's rights are granted for the whole database (`SELECT, INSERT, UPDATE, DELETE ON db.*`),
    // which the framework's own schema run established before: the tables the library creates are covered by it. A
    // table it creates gets the framework's collation, which the library cannot be told — switched only on a run that
    // creates one, because the switch locks every table of the database
    withForeignSchemaLock: (lock, tables, migrate) =>
      withMysqlSchemaLock(lock, async (run) =>
        (await anyTableMissing(run, tables)) ? withFrameworkDefaultCollation(run, migrate) : migrate(),
      ),
  };
}
