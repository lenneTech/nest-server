import type { DatabaseSqlEngine } from '../../common/interfaces/server-options.interface.js';
import { createSqlExecutor, installedSqlEngine } from '../../common/persistence/sql/sql-executor.factory.js';
import type { SqlExecutor, SqlTenantScope } from '../../common/persistence/sql/sql-executor.interface.js';
import { quoteIdentifier, quoteMysqlIdentifier } from '../../common/persistence/sql/sql-naming.js';
import type { MigrationSet, MigrationStateStore } from './migration-state-store.interface.js';

const SYSTEM: SqlTenantScope = { kind: 'system' };

/**
 * Serialises migration runs of every replica: a transaction-scoped advisory lock, held by the transaction that
 * surrounds the whole run. It ends with that transaction — and with its connection, so a replica killed mid-migration
 * leaves nothing behind that another one would have to break (MongoDB needs a heartbeat and a stale-lock rule for
 * that). A key of its own: the boot's schema evolution (`SCHEMA_LOCK_SQL`) must stay possible while a run waits.
 */
const MIGRATION_RUN_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('lenne.tech:migrations'))";

/**
 * MySQL / MariaDB: a named lock per database, held by the session of the locking connection. It ends with that
 * connection too, so a killed replica leaves nothing behind; released explicitly at the end of a run. The wait is
 * bounded at a day — a run that takes longer is not waited for
 */
const MYSQL_RUN_LOCK_NAME = "CONCAT('lenne.tech:migrations:', SHA1(DATABASE()))";
const MYSQL_RUN_LOCK_TIMEOUT_SECONDS = 86_400;

export interface SqlStateStoreOptions {
  /**
   * SQL engine of the connection, the project's configured one. Without it the first INSTALLED engine is used
   * (`typeorm`, `kysely`, `drizzle`): `createMigrationStore()` runs in the migrate CLI, which has no configuration to
   * read it from. @default the first installed engine
   */
  engine?: DatabaseSqlEngine;
  /** `false` runs migrations without the run lock — one replica only. @default true */
  lock?: boolean;
  /** Table holding the migration state. @default 'lt_migrations' */
  tableName?: string;
  /**
   * Connection URL of the table OWNER (`database.ownerUrl`): migrations change the schema and the data of every
   * tenant, which the application role may not
   */
  url: string;
}

/**
 * Migration state on PostgreSQL, MySQL and MariaDB (the URL's scheme decides) — the counterpart of `MongoStateStore`:
 * one row with the last run and the applied migrations, read and written by `MigrationRunner` and the `migrate` CLI,
 * with every run serialised across replicas.
 *
 * Each call opens and closes its own connection, as `MongoStateStore` does: the CLI and the container entrypoint run it
 * once per boot, and a pool kept open would hold the process.
 */
export class SqlStateStore implements MigrationStateStore {
  readonly url: string;
  protected readonly engine: DatabaseSqlEngine | undefined;
  protected readonly locked: boolean;
  /** MySQL and MariaDB share one dialect here */
  protected readonly mysql: boolean;
  protected readonly table: string;

  constructor(options: SqlStateStoreOptions | string) {
    const resolved = typeof options === 'string' ? { url: options } : options;
    if (!resolved.url) {
      throw new Error('SqlStateStore needs the connection URL of the table owner (database.ownerUrl)');
    }
    this.url = resolved.url;
    this.engine = resolved.engine;
    this.locked = resolved.lock !== false;
    this.mysql = /^(mysql|mariadb):/i.test(resolved.url);
    this.table = (this.mysql ? quoteMysqlIdentifier : quoteIdentifier)(resolved.tableName ?? 'lt_migrations');
  }

  load(fn: (err?: Error, set?: MigrationSet) => void): void {
    this.loadAsync()
      .then((result) => fn(undefined, result))
      .catch((err) => fn(err));
  }

  async loadAsync(): Promise<MigrationSet> {
    return this.request(async (executor) => {
      const { rows } = await executor.run<{ last_run: null | string; migrations: MigrationSet['migrations'] | string }>(
        {
          params: [],
          text: this.mysql
            ? `SELECT \`last_run\`, \`migrations\` FROM ${this.table} WHERE \`id\` = 'state'`
            : `SELECT "last_run", "migrations" FROM ${this.table} WHERE "id" = 'state'`,
        },
        SYSTEM,
      );
      if (!rows.length) {
        console.debug('No migrations found, probably running the very first time');
        // An empty object, as MongoStateStore returns for a first run
        return {} as MigrationSet;
      }
      const migrations = rows[0].migrations;
      return {
        lastRun: rows[0].last_run ?? undefined,
        // MariaDB's JSON is text where the driver does not recognise it
        migrations: typeof migrations === 'string' ? JSON.parse(migrations) : migrations,
      } as MigrationSet;
    });
  }

  save(set: MigrationSet, fn: (err?: Error) => void): void {
    this.saveAsync(set)
      .then(() => fn())
      .catch((err) => fn(err));
  }

  async saveAsync(set: MigrationSet): Promise<void> {
    const { lastRun, migrations } = set;
    await this.request((executor) =>
      executor.run(
        {
          params: [lastRun ?? null, JSON.stringify(migrations ?? [])],
          text: this.mysql
            ? `INSERT INTO ${this.table} (\`id\`, \`last_run\`, \`migrations\`, \`updated_at\`) VALUES ('state', $1, $2, UTC_TIMESTAMP(3))
              ON DUPLICATE KEY UPDATE \`last_run\` = $1, \`migrations\` = $2, \`updated_at\` = UTC_TIMESTAMP(3)`
            : `INSERT INTO ${this.table} ("id", "last_run", "migrations", "updated_at") VALUES ('state', $1, $2::jsonb, now())
              ON CONFLICT ("id") DO UPDATE SET "last_run" = EXCLUDED."last_run", "migrations" = EXCLUDED."migrations", "updated_at" = now()`,
        },
        SYSTEM,
      ),
    );
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.locked) {
      return fn();
    }
    const executor = await this.open();
    try {
      // The work itself runs on other connections (the runner reads and saves the state, migrations open their own);
      // this transaction only holds the lock for as long as the work takes
      return await executor.transaction(async (tx) => {
        if (!this.mysql) {
          await tx.run({ params: [], text: MIGRATION_RUN_LOCK_SQL }, SYSTEM);
          return fn();
        }
        const { rows } = await tx.run<{ locked: number | string }>(
          {
            params: [MYSQL_RUN_LOCK_TIMEOUT_SECONDS],
            text: `SELECT GET_LOCK(${MYSQL_RUN_LOCK_NAME}, $1) AS locked`,
          },
          SYSTEM,
        );
        if (Number(rows[0]?.locked) !== 1) {
          throw new Error('Timed out waiting for the migration run of another process');
        }
        try {
          return await fn();
        } finally {
          await tx
            .run({ params: [], text: `SELECT RELEASE_LOCK(${MYSQL_RUN_LOCK_NAME})` }, SYSTEM)
            .catch(() => undefined);
        }
      });
    } finally {
      await executor.close();
    }
  }

  protected async request<R>(work: (executor: SqlExecutor) => Promise<R>): Promise<R> {
    const executor = await this.open();
    try {
      return await work(executor);
    } finally {
      await executor.close();
    }
  }

  /** A connection of its own, with the state table in place */
  protected async open(): Promise<SqlExecutor> {
    const executor = await createSqlExecutor({
      applicationName: 'nest-server-migrations',
      engine: this.engine ?? (await installedSqlEngine()),
      maxConnections: 1,
      url: this.url,
    });
    try {
      await executor.run(
        {
          params: [],
          text: this.mysql
            ? `CREATE TABLE IF NOT EXISTS ${this.table} (\`id\` varchar(255) NOT NULL PRIMARY KEY, \`last_run\` longtext, \`migrations\` json NOT NULL, \`updated_at\` datetime(3) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
            : `CREATE TABLE IF NOT EXISTS ${this.table} ("id" text PRIMARY KEY, "last_run" text, "migrations" jsonb NOT NULL DEFAULT '[]'::jsonb, "updated_at" timestamptz NOT NULL DEFAULT now())`,
        },
        SYSTEM,
      );
    } catch (error) {
      // Two replicas creating the table at the same moment: IF NOT EXISTS is not atomic in PostgreSQL, the loser fails
      // with a duplicate of the table (42P07) or of its row type (23505) — and the table exists, which is all it asked
      if (!['23505', '42P07'].includes((error as { code?: string })?.code)) {
        await executor.close();
        throw error;
      }
    }
    return executor;
  }
}
