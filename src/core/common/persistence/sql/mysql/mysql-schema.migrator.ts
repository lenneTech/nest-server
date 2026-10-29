import type { ModelDescriptor } from '../../model-descriptor.interface.js';
import { isForeignColumn } from '../../persistence-runtime.registry.js';
import type { SqlExecutor, SqlQueryResult, SqlStatement, SqlTenantScope } from '../sql-executor.interface.js';
import { quoteMysqlIdentifier } from '../sql-naming.js';
import {
  LOCK_MODEL,
  type SchemaChange,
  SchemaMigrationRequiredError,
  SchemaOutOfDateError,
  UnsafeDatabaseRoleError,
} from '../sql-schema.shared.js';
import type { MysqlVariant } from './mysql-session.js';
import {
  addMysqlCheckStatement,
  createMysqlTableStatement,
  desiredMysqlTable,
  type MysqlDesiredColumn,
  type MysqlDesiredTable,
  mysqlColumnDefinition,
  NULL_SENTINEL_PREFIX,
  variantLabel,
} from './mysql-schema.compiler.js';

/**
 * Safe, framework-owned schema evolution on MySQL and MariaDB — the rules of `postgres-schema.migrator.ts`
 * (`automatic` applied, `migration` refuses the boot, `notice` logged; nothing dropped or narrowed automatically).
 *
 * Two things differ. A DDL statement commits on its own in MySQL, so a run is not one transaction: it is serialized by
 * a named lock (`GET_LOCK`, per database) instead, and a run that fails half-way leaves the statements it applied —
 * each of them is one the next run would plan again, so the next boot completes it. And the application account gets
 * its rights once for the database (`SELECT, INSERT, UPDATE, DELETE ON db.*`), which covers every table the framework
 * creates later, instead of per table.
 */

export interface MysqlSchemaOptions {
  /** The application account as MySQL names it (`'user'@'host'`, `mysqlAccount()`) */
  appAccount: string;
  variant: MysqlVariant;
}

const SYSTEM: SqlTenantScope = { kind: 'system' };
/** One lock per database, shorter than GET_LOCK's 64 characters whatever the database is called */
const LOCK_NAME = "CONCAT('lenne.tech:schema:', SHA1(DATABASE()))";
/** How long a boot waits for another replica's schema run, in seconds */
const LOCK_TIMEOUT_SECONDS = 120;
/** The rights the application account needs, and the only ones it may hold on the framework's tables */
const DML = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
/** Rights that let an account change or drop what the framework created, or hand rights on */
const FORBIDDEN = new Set([
  'ALTER',
  'ALTER ROUTINE',
  'CREATE',
  'CREATE ROUTINE',
  'CREATE USER',
  'CREATE VIEW',
  'DROP',
  'GRANT OPTION',
  'INDEX',
  'REFERENCES',
  'SUPER',
  'SYSTEM_USER',
  'TRIGGER',
]);
/** Lowest supported servers — the versions the framework is tested against */
export const MIN_MYSQL_VERSION = [8, 4] as const;
export const MIN_MARIADB_VERSION = [11, 8] as const;

type Run = (statement: SqlStatement) => Promise<SqlQueryResult<any>>;

interface CatalogTable {
  checks: Set<string>;
  columns: Map<string, { collation: null | string; generated: boolean; type: string }>;
  /** framework-named index → unique */
  indexes: Map<string, boolean>;
}

interface Catalog {
  database: string;
  /** Whether the application account holds every DML right on the database */
  granted: boolean;
  tables: Map<string, CatalogTable>;
}

/** `'user'@'host'` of the account a connection runs as */
export async function mysqlAccount(executor: SqlExecutor): Promise<string> {
  const { rows } = await executor.run<{ account: string }>(
    { params: [], text: 'SELECT CURRENT_USER() AS account' },
    SYSTEM,
  );
  const account = rows[0].account;
  const at = account.lastIndexOf('@');
  return `'${account.slice(0, at)}'@'${account.slice(at + 1)}'`;
}

/** `fn` on one owner connection holding the schema lock — the boot's evolution and `runSqlMigration()` alike */
export async function withMysqlSchemaLock<T>(owner: SqlExecutor, fn: (run: Run) => Promise<T>): Promise<T> {
  return owner.transaction(async (tx) => {
    const run: Run = (statement) => tx.run(statement, SYSTEM);
    const { rows } = await run({ params: [LOCK_TIMEOUT_SECONDS], text: `SELECT GET_LOCK(${LOCK_NAME}, $1) AS locked` });
    if (Number(rows[0]?.locked) !== 1) {
      throw new Error(`Timed out after ${LOCK_TIMEOUT_SECONDS}s waiting for the schema lock of another process`);
    }
    try {
      return await fn(run);
    } finally {
      // Session-scoped: never left to the pool, where it would block every later run
      await run({ params: [], text: `SELECT RELEASE_LOCK(${LOCK_NAME})` }).catch(() => undefined);
    }
  });
}

/** Apply every automatic change as the OWNER, under the schema lock; refuse when a migration is needed. */
export async function applyMysqlSchema(
  owner: SqlExecutor,
  models: ModelDescriptor[],
  options: MysqlSchemaOptions,
): Promise<SchemaChange[]> {
  return withMysqlSchemaLock(owner, async (run) => {
    const changes = await planMysqlSchema(run, models, options);
    const migrations = changes.filter((change) => change.kind === 'migration');
    if (migrations.length) {
      throw new SchemaMigrationRequiredError(migrations);
    }
    for (const change of changes) {
      if (change.kind === 'automatic') {
        for (const text of change.statements) {
          try {
            await run({ params: [], text });
          } catch (error) {
            // Without a transaction the statements before this one stay applied; say which change stopped the run
            throw new Error(`Schema change "${change.description}" failed: ${(error as Error).message}`, {
              cause: error,
            });
          }
        }
      }
    }
    return changes;
  });
}

/** Without an owner connection: only check, as the APPLICATION account, and refuse to start on any pending change. */
export async function verifyMysqlSchema(
  app: SqlExecutor,
  models: ModelDescriptor[],
  options: MysqlSchemaOptions,
): Promise<SchemaChange[]> {
  const changes = await planMysqlSchema((statement) => app.run(statement, SYSTEM), models, options);
  const pending = changes.filter((change) => change.kind !== 'notice');
  if (pending.length) {
    throw new SchemaOutOfDateError(pending);
  }
  return changes;
}

export async function planMysqlSchema(
  run: Run,
  models: ModelDescriptor[],
  options: MysqlSchemaOptions,
): Promise<SchemaChange[]> {
  const all = models.some((model) => model.name === LOCK_MODEL.name) ? models : [...models, LOCK_MODEL];
  const tables = all.map((model) => desiredMysqlTable(model, options.variant));
  const catalog = await readCatalog(
    run,
    tables.map((table) => table.name),
    options.appAccount,
  );
  const changes: SchemaChange[] = [];
  if (!catalog.granted) {
    changes.push({
      description: `grant ${options.appAccount} SELECT, INSERT, UPDATE, DELETE on database ${catalog.database}`,
      kind: 'automatic',
      statements: [
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteMysqlIdentifier(catalog.database)}.* TO ${options.appAccount}`,
      ],
    });
  }
  for (const table of tables) {
    for (const notice of table.notices) {
      changes.push({ description: notice, kind: 'notice', statements: [], table: table.name });
    }
    const existing = catalog.tables.get(table.name);
    changes.push(...(existing ? planExistingTable(table, existing) : planNewTable(table)));
  }
  return changes;
}

function planNewTable(table: MysqlDesiredTable): SchemaChange[] {
  return [
    {
      description: `create table ${table.name} (${table.model.name})`,
      kind: 'automatic',
      statements: [createMysqlTableStatement(table), ...table.indexes.map((index) => index.create)],
      table: table.name,
    },
  ];
}

function planExistingTable(table: MysqlDesiredTable, existing: CatalogTable): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const name = table.name;
  const quoted = quoteMysqlIdentifier(name);
  const declared = new Set<string>();
  // The null sentinels of a NEW unique index belong to that index's migration: added on their own, the boot that
  // refuses the index would never get to them, and the suggested CREATE INDEX would name a column that does not exist
  const deferred = new Set(
    table.indexes
      .filter((index) => index.unique && !existing.indexes.has(index.name))
      .flatMap((index) => index.sentinels ?? [])
      .filter((sentinel) => !existing.columns.has(sentinel)),
  );

  for (const column of table.columns) {
    declared.add(column.name);
    const current = existing.columns.get(column.name);
    if (!current && deferred.has(column.name)) {
      continue;
    }
    if (!current) {
      const previous = column.renamedFrom ? existing.columns.get(column.renamedFrom) : undefined;
      if (previous) {
        declared.add(column.renamedFrom);
        changes.push({
          description: `rename ${name}.${column.renamedFrom} to ${column.name} (declared renamedFrom)`,
          kind: 'automatic',
          statements: [
            `ALTER TABLE ${quoted} RENAME COLUMN ${quoteMysqlIdentifier(column.renamedFrom)} TO ${quoteMysqlIdentifier(column.name)}`,
          ],
          table: name,
        });
        if (!sameType(column, previous)) {
          changes.push(typeChange(name, column, previous));
        }
        continue;
      }
      changes.push({
        description: `add ${column.generated ? 'virtual ' : ''}column ${name}.${column.name}`,
        kind: 'automatic',
        statements: [`ALTER TABLE ${quoted} ADD COLUMN ${mysqlColumnDefinition({ ...column, primaryKey: false })}`],
        table: name,
      });
      continue;
    }
    if (column.renamedFrom && existing.columns.has(column.renamedFrom)) {
      declared.add(column.renamedFrom);
      changes.push({
        description: `${name}.${column.name} is declared as renamed from ${column.renamedFrom}, but both columns exist — move the data and drop the old column in a migration`,
        kind: 'migration',
        statements: [],
        table: name,
      });
    }
    if (!column.generated && !sameType(column, current)) {
      changes.push(typeChange(name, column, current));
    }
  }
  for (const column of existing.columns.keys()) {
    if (!declared.has(column) && !column.startsWith(NULL_SENTINEL_PREFIX) && !isForeignColumn(name, column)) {
      changes.push({
        description: `${name}.${column} is no longer declared; the column is kept until a migration drops it`,
        kind: 'notice',
        statements: [],
        table: name,
      });
    }
  }

  for (const check of table.checks) {
    if (!existing.checks.has(check.name)) {
      changes.push({
        description: `add check ${check.name} on ${name}`,
        kind: 'automatic',
        statements: [addMysqlCheckStatement(name, check)],
        table: name,
      });
    }
  }

  const wanted = new Set(table.indexes.map((index) => index.name));
  const added = new Set<string>();
  for (const index of table.indexes) {
    if (existing.indexes.has(index.name)) {
      continue;
    }
    const sentinels = (index.sentinels ?? []).filter((sentinel) => deferred.has(sentinel) && !added.has(sentinel));
    sentinels.forEach((sentinel) => added.add(sentinel));
    changes.push({
      description: `create ${index.unique ? 'unique ' : ''}index ${index.name} on ${name}`,
      // A unique index can fail on the rows already stored, and it changes what may be written: a reviewed decision
      kind: index.unique ? 'migration' : 'automatic',
      statements: [
        ...sentinels.map(
          (sentinel) =>
            `ALTER TABLE ${quoted} ADD COLUMN ${mysqlColumnDefinition(table.columns.find((column) => column.name === sentinel)!)}`,
        ),
        index.create,
      ],
      table: name,
    });
  }
  for (const [index] of existing.indexes) {
    if (!wanted.has(index)) {
      changes.push({
        description: `index ${index} on ${name} is no longer declared; it is kept until a migration drops it`,
        kind: 'notice',
        statements: [],
        table: name,
      });
    }
  }
  return changes;
}

function sameType(column: MysqlDesiredColumn, current: { collation: null | string; type: string }): boolean {
  if (column.type !== current.type) {
    return false;
  }
  // Text compares byte-wise or not at all the way MongoDB does; JSON's collation is the server's business
  const text = !column.json && ['char(36)', 'longtext', 'varchar(255)'].includes(column.type);
  return !text || current.collation === 'utf8mb4_bin';
}

function typeChange(
  table: string,
  column: MysqlDesiredColumn,
  current: { collation: null | string; type: string },
): SchemaChange {
  return {
    description: `${table}.${column.name} is ${current.type}${current.collation ? ` COLLATE ${current.collation}` : ''}, the model asks for ${mysqlColumnDefinition({ ...column, default: undefined, primaryKey: false }).replace(/^`[^`]+` /, '')}`,
    kind: 'migration',
    statements: [
      `ALTER TABLE ${quoteMysqlIdentifier(table)} MODIFY COLUMN ${mysqlColumnDefinition({ ...column, primaryKey: false })}`,
    ],
    table,
  };
}

/** A catalog column type in the form the compiler writes: no display width (MariaDB prints `bigint(20)`) */
export function mysqlCatalogType(type: string): string {
  const lower = type.toLowerCase().trim();
  return lower === 'tinyint(1)' ? lower : lower.replace(/^(bigint|int|mediumint|smallint|tinyint)\(\d+\)/, '$1');
}

async function readCatalog(run: Run, tables: string[], appAccount: string): Promise<Catalog> {
  const list = tables.map((_table, index) => `$${index + 1}`).join(', ');
  const database = (await run({ params: [], text: 'SELECT DATABASE() AS name' })).rows[0]?.name;
  if (!database) {
    throw new Error('The MySQL / MariaDB connection URL names no database');
  }
  const columnResult = await run({
    params: tables,
    text: `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, COLLATION_NAME AS collation, EXTRA AS extra
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${list})`,
  });
  const indexResult = await run({
    params: tables,
    text: `SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS name, NON_UNIQUE AS non_unique
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${list})
        AND (INDEX_NAME LIKE 'ix\\_%' OR INDEX_NAME LIKE 'ux\\_%')`,
  });
  const checkResult = await run({
    params: tables,
    text: `SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME IN (${list}) AND CONSTRAINT_TYPE = 'CHECK'`,
  });
  const grantResult = await run({
    params: [appAccount],
    text: `SELECT PRIVILEGE_TYPE AS privilege FROM information_schema.SCHEMA_PRIVILEGES
      WHERE GRANTEE = $1 AND TABLE_SCHEMA = DATABASE()`,
  });

  const catalog: Catalog = {
    database,
    granted: DML.every((privilege) => grantResult.rows.some((row) => row.privilege === privilege)),
    tables: new Map(),
  };
  const table = (name: string) => {
    let entry = catalog.tables.get(name);
    if (!entry) {
      entry = { checks: new Set(), columns: new Map(), indexes: new Map() };
      catalog.tables.set(name, entry);
    }
    return entry;
  };
  for (const row of columnResult.rows) {
    table(row.t).columns.set(row.c, {
      collation: row.collation ?? null,
      generated: /GENERATED/i.test(row.extra ?? ''),
      type: mysqlCatalogType(row.type),
    });
  }
  for (const row of indexResult.rows) {
    table(row.t).indexes.set(row.name, Number(row.non_unique) === 0);
  }
  for (const row of checkResult.rows) {
    table(row.t).checks.add(row.name);
  }
  return catalog;
}

/**
 * The boot check of the APPLICATION connection (plan §3.9, phase 6): with no row-level security, the framework's tables
 * and their constraints (the roles CHECK, the unique indexes) are what the store's policies rely on, so the account the
 * application runs as may read and write rows and nothing else — no right to change, drop or index a table, no trigger,
 * no granting. Also refuses a server older than the tested versions.
 */
export async function assertSafeMysqlApplicationAccount(app: SqlExecutor, variant: MysqlVariant): Promise<void> {
  const { rows } = await app.run<{ version: string }>({ params: [], text: 'SELECT VERSION() AS version' }, SYSTEM);
  const version = rows[0].version;
  const isMariaDb = /mariadb/i.test(version);
  if (isMariaDb !== (variant === 'mariadb')) {
    throw new UnsafeDatabaseRoleError(
      `The URL names ${variantLabel(variant)}, but the server is ${isMariaDb ? 'MariaDB' : 'MySQL'} ${version} — use the ${isMariaDb ? 'mariadb' : 'mysql'}:// scheme`,
    );
  }
  const [major, minor] = version.split(/[.-]/).map(Number);
  const [needMajor, needMinor] = isMariaDb ? MIN_MARIADB_VERSION : MIN_MYSQL_VERSION;
  if (major < needMajor || (major === needMajor && minor < needMinor)) {
    throw new UnsafeDatabaseRoleError(
      `${variantLabel(variant)} ${version} is not supported; version ${needMajor}.${needMinor} or newer is required`,
    );
  }

  const account = await mysqlAccount(app);
  const privileges = await app.run<{ grantable: string; privilege: string; scope: string }>(
    {
      params: [account],
      text: `SELECT PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable, 'global' AS scope
          FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = $1
        UNION ALL SELECT PRIVILEGE_TYPE, IS_GRANTABLE, 'database' FROM information_schema.SCHEMA_PRIVILEGES
          WHERE GRANTEE = $1 AND TABLE_SCHEMA = DATABASE()
        UNION ALL SELECT PRIVILEGE_TYPE, IS_GRANTABLE, CONCAT('table ', TABLE_NAME) FROM information_schema.TABLE_PRIVILEGES
          WHERE GRANTEE = $1 AND TABLE_SCHEMA = DATABASE()`,
    },
    SYSTEM,
  );
  const problems = new Set<string>();
  for (const row of privileges.rows) {
    if (FORBIDDEN.has(row.privilege)) {
      problems.add(`${row.privilege} (${row.scope})`);
    }
    if (row.grantable === 'YES') {
      problems.add(`the right to grant ${row.privilege} (${row.scope})`);
    }
  }
  if (problems.size) {
    throw new UnsafeDatabaseRoleError(
      `The application account ${account} holds ${[...problems].sort().join(', ')}. Without row-level security the ` +
        'framework relies on its tables and constraints staying as they are: connect `database.url` as an account ' +
        'that may only SELECT, INSERT, UPDATE and DELETE, and give the owner account to `database.ownerUrl`.',
    );
  }
}
