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
  LIVE_KEY_PREFIX,
  MYSQL_SYNC_COUNTERS,
  MYSQL_SYNC_TRIGGER_VERSION,
  mysqlColumnDefinition,
  mysqlSyncCountersStatement,
  mysqlSyncTableStatements,
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
  /** Change-order triggers (`lt_sync_*`) on the table, as far as the connection may see them (the owner does) */
  syncTriggers: Set<string>;
  /** The trigger version the counter row records — readable by the application account too */
  syncTriggerVersion: null | string;
}

interface Catalog {
  database: string;
  /** Whether the application account holds every DML right on the database */
  granted: boolean;
  /** Whether the counter table of synchronized models exists */
  syncCounters: boolean;
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

/** The collation of every table the framework creates — byte-wise, as identifiers and tokens compare on PostgreSQL */
const FRAMEWORK_COLLATION = 'utf8mb4_bin';
/**
 * How long a collation switch waits for the metadata locks it needs, in seconds. `ALTER DATABASE` locks every table of
 * the database exclusively, one after the other: behind an open transaction it waits, and every statement on the
 * tables it already holds waits with it. The server's own default is a year
 */
const COLLATION_SWITCH_LOCK_WAIT_SECONDS = 5;

/** Whether any of `tables` does not exist yet — only then does a library's migration create a table */
export async function anyTableMissing(run: Run, tables: string[]): Promise<boolean> {
  if (!tables.length) {
    return false;
  }
  const { rows } = await run({
    params: tables,
    text: `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map((_, index) => `$${index + 1}`).join(', ')})`,
  });
  return Number(rows[0]?.n) < new Set(tables).size;
}

/**
 * `fn` with the database's default collation switched to the framework's and back afterwards — for a library that
 * creates its tables without naming a collation (Better-Auth). Its tables then compare byte-wise like the framework's,
 * and its foreign keys to them can be created at all: MariaDB refuses a key between `utf8mb4_bin` (`users.id`) and the
 * server's default (`Foreign key constraint is incorrectly formed`), and on MySQL tokens and identifiers would compare
 * case-insensitively. Restored afterwards, so the project's own DDL keeps the default it was given. Runs as the owner
 * under the schema lock (`run` is the lock's connection); a process that dies in between leaves `utf8mb4_bin` behind,
 * which changes no existing table.
 *
 * Only for a run that creates a table (`anyTableMissing()`): a column added to an existing table takes that table's
 * collation, and the switch locks every table of the database. Its wait is bounded, so a first boot behind a long
 * transaction fails with an error instead of freezing the database.
 */
export async function withFrameworkDefaultCollation<T>(run: Run, fn: () => Promise<T>): Promise<T> {
  const { rows } = await run({
    params: [],
    text: `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation
      FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()`,
  });
  const { charset, collation } = (rows[0] ?? {}) as { charset?: string; collation?: string };
  if (collation === FRAMEWORK_COLLATION) {
    return fn();
  }
  if (!/^\w+$/.test(charset ?? '') || !/^\w+$/.test(collation ?? '')) {
    throw new Error(`Cannot read the default collation of the database (found ${charset}/${collation})`);
  }
  const { rows: timeouts } = await run({ params: [], text: 'SELECT @@SESSION.lock_wait_timeout AS timeout' });
  const previousTimeout = Number(timeouts[0]?.timeout);
  await run({ params: [], text: `SET SESSION lock_wait_timeout = ${COLLATION_SWITCH_LOCK_WAIT_SECONDS}` });
  try {
    await run({ params: [], text: `ALTER DATABASE CHARACTER SET utf8mb4 COLLATE ${FRAMEWORK_COLLATION}` });
    try {
      return await fn();
    } finally {
      await run({ params: [], text: `ALTER DATABASE CHARACTER SET ${charset} COLLATE ${collation}` });
    }
  } finally {
    if (Number.isInteger(previousTimeout) && previousTimeout > 0) {
      await run({ params: [], text: `SET SESSION lock_wait_timeout = ${previousTimeout}` });
    }
  }
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
  if (tables.some((table) => table.sync) && !catalog.syncCounters) {
    changes.push({
      description: `create the change-order counters ${MYSQL_SYNC_COUNTERS}`,
      kind: 'automatic',
      statements: [mysqlSyncCountersStatement()],
    });
  }
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
      statements: [
        createMysqlTableStatement(table),
        ...table.indexes.map((index) => index.create),
        ...(table.sync ? mysqlSyncTableStatements(table.name, table.sync) : []),
      ],
      table: table.name,
    },
  ];
}

/**
 * A synchronized table's change order: both triggers of the current version and its counter row. Triggers of an earlier
 * version are replaced; a table that is no longer synchronized keeps its triggers until a migration drops them
 */
function planSync(table: MysqlDesiredTable, existing: CatalogTable): SchemaChange[] {
  const name = table.name;
  if (!table.sync) {
    return existing.syncTriggers.size
      ? [
          {
            description: `${name} is no longer synchronized; its change-order triggers are kept until a migration drops them`,
            kind: 'notice',
            statements: [],
            table: name,
          },
        ]
      : [];
  }
  if (existing.syncTriggerVersion === MYSQL_SYNC_TRIGGER_VERSION) {
    return [];
  }
  const current = new Set([table.sync.insertTrigger, table.sync.updateTrigger]);
  return [
    {
      description: `${existing.syncTriggerVersion ? 'replace' : 'add'} the change-order triggers of ${name}`,
      kind: 'automatic',
      statements: [
        ...[...existing.syncTriggers]
          .filter((trigger) => !current.has(trigger))
          .map((trigger) => `DROP TRIGGER IF EXISTS ${quoteMysqlIdentifier(trigger)}`),
        ...mysqlSyncTableStatements(name, table.sync),
      ],
      table: name,
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
    if (
      !declared.has(column) &&
      !column.startsWith(NULL_SENTINEL_PREFIX) &&
      !column.startsWith(LIVE_KEY_PREFIX) &&
      !isForeignColumn(name, column)
    ) {
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
  changes.push(...planSync(table, existing));
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
  const triggerResult = await run({
    params: tables,
    text: `SELECT EVENT_OBJECT_TABLE AS t, TRIGGER_NAME AS name FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE IN (${list}) AND TRIGGER_NAME LIKE 'lt\\_sync\\_%'`,
  });
  const countersResult = await run({
    params: [MYSQL_SYNC_COUNTERS],
    text: `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1`,
  });
  const counterRows = Number(countersResult.rows[0]?.n)
    ? (
        await run({
          params: tables,
          text: `SELECT \`model\` AS t, \`triggers\` AS version FROM ${quoteMysqlIdentifier(MYSQL_SYNC_COUNTERS)} WHERE \`model\` IN (${list})`,
        })
      ).rows
    : [];

  const catalog: Catalog = {
    database,
    granted: DML.every((privilege) => grantResult.rows.some((row) => row.privilege === privilege)),
    syncCounters: Number(countersResult.rows[0]?.n) > 0,
    tables: new Map(),
  };
  const table = (name: string) => {
    let entry = catalog.tables.get(name);
    if (!entry) {
      entry = {
        checks: new Set(),
        columns: new Map(),
        indexes: new Map(),
        syncTriggers: new Set(),
        syncTriggerVersion: null,
      };
      catalog.tables.set(name, entry);
    }
    return entry;
  };
  for (const row of triggerResult.rows) {
    table(row.t).syncTriggers.add(row.name);
  }

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
  // After the columns: only a table that exists has a counter row worth reading
  for (const row of counterRows) {
    if (catalog.tables.has(row.t)) {
      table(row.t).syncTriggerVersion = row.version ?? null;
    }
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
