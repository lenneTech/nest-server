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
  verifyMysqlSchema,
} from './mysql/mysql-schema.migrator.js';
import type { MysqlVariant } from './mysql/mysql-session.js';
import { PostgresLockStore } from './postgres/postgres-lock-store.js';
import type { PostgresSchemaOptions } from './postgres/postgres-schema.compiler.js';
import {
  applyPostgresSchema,
  assertSafeApplicationRole,
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
  /** How a tenant-isolated model's rows are protected, for the boot log */
  isolation(isolated: boolean): string;
  /** Without an owner connection: only check, and refuse to start on any pending change */
  verifySchema(app: SqlExecutor, models: ModelDescriptor[]): Promise<SchemaChange[]>;
}

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
    isolation: (isolated) => (isolated ? ' (row-level security)' : ''),
    label: 'PostgreSQL',
    verifySchema: (app, models) => verifyPostgresSchema(app, models, options),
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
    isolation: (isolated) => (isolated ? ' (tenant isolation in the application only)' : ''),
    label: variant === 'mysql' ? 'MySQL' : 'MariaDB',
    verifySchema: async (app, models) => verifyMysqlSchema(app, models, await options(app)),
  };
}
