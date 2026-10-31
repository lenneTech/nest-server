import type { DatabaseSqlEngine } from '../../common/interfaces/server-options.interface.js';
import { withMysqlSchemaLock } from '../../common/persistence/sql/mysql/mysql-schema.migrator.js';
import { MYSQL_SYNC_COUNTERS } from '../../common/persistence/sql/mysql/mysql-schema.compiler.js';
import { syncSequenceName } from '../../common/persistence/sql/postgres/postgres-schema.compiler.js';
import { SCHEMA_LOCK_SQL } from '../../common/persistence/sql/postgres/postgres-schema.migrator.js';
import { createSqlExecutor } from '../../common/persistence/sql/sql-executor.factory.js';
import { quoteIdentifier, quoteMysqlIdentifier } from '../../common/persistence/sql/sql-naming.js';

/**
 * A data migration's multi-row write on the table of a synchronized model, numbered the way the store numbers it (plan
 * §3.4, C1d): the rows are locked first (`SELECT … FOR UPDATE`), then the change numbers taken, then the rows written
 * with their numbers set and their `version` incremented. "Rows first, counter last" is what keeps the migration from
 * deadlocking with a running application's writes on MySQL and MariaDB, whose row locks also lock index gaps; the
 * incremented version turns the change into a conflict for a client that edited the old one, never a silent overwrite.
 * Clients receive the rows at their next pull, like any change.
 *
 * `set` and `where` are SQL, reviewed like every statement of the migration — never built from request data.
 */
export interface SqlSyncUpdate {
  syncUpdate: {
    /** Assignments without `SET`, e.g. `"status" = 'archived'` (never `version` or `sync_seq`, both set here) */
    set: string;
    /** The table of the synchronized model, e.g. `sync_notes` */
    table: string;
    /** The rows to write, a condition without `WHERE` */
    where: string;
  };
}

/** How a migration statement runs: on the migration's connection, inside its transaction where there is one */
export type SqlMigrationRun = (statement: { params: unknown[]; text: string }) => Promise<{ rows: any[] }>;

/** Rows written per statement */
const SYNC_UPDATE_CHUNK = 500;

/**
 * Run the reviewed statements of a SQL migration (`migrate create <name> --sql`) as the table OWNER, under the lock the
 * boot's schema migration takes, so a replica booting meanwhile waits and then sees the result. On PostgreSQL in one
 * transaction: either every statement applies or none does. MySQL and MariaDB commit every DDL statement on its own, so
 * there a failure leaves the statements before it applied — write such a migration so it can run again. A `syncUpdate`
 * runs in a transaction of its own there, because a DDL statement before it has ended the migration's.
 *
 * The statements are the ones a refused boot suggested (`SchemaMigrationRequiredError`) — after review: a narrowed
 * type, a new unique index or a rename collision can reject or rewrite stored rows, which is why the framework never
 * runs them on its own (plan §3.12).
 */
export async function runSqlMigration(
  ownerUrl: string,
  statements: readonly (SqlSyncUpdate | string)[],
  options: { engine?: DatabaseSqlEngine } = {},
): Promise<void> {
  if (!ownerUrl) {
    throw new Error('runSqlMigration() needs the connection URL of the table owner (database.ownerUrl)');
  }
  const executor = await createSqlExecutor({
    applicationName: 'nest-server-migration',
    engine: options.engine ?? 'typeorm',
    maxConnections: 1,
    url: ownerUrl,
  });
  try {
    if (/^(mysql|mariadb):/i.test(ownerUrl)) {
      await withMysqlSchemaLock(executor, async (run) => {
        for (const statement of statements) {
          await (typeof statement === 'string'
            ? run({ params: [], text: statement })
            : applySqlSyncUpdate(run, 'mysql', statement.syncUpdate));
        }
      });
      return;
    }
    await executor.transaction(async (tx) => {
      const run: SqlMigrationRun = (statement) => tx.run(statement, { kind: 'system' });
      await run({ params: [], text: SCHEMA_LOCK_SQL });
      for (const statement of statements) {
        await (typeof statement === 'string'
          ? run({ params: [], text: statement })
          : applySqlSyncUpdate(run, 'postgres', statement.syncUpdate));
      }
    });
  } finally {
    await executor.close();
  }
}

/**
 * One `syncUpdate` of a migration: rows locked, numbers taken, rows written, in one transaction — the migration's on
 * PostgreSQL. On MySQL / MariaDB in a transaction of its own: a DDL statement earlier in the migration committed the
 * migration's transaction implicitly, and in autocommit every statement would release its locks at once — a running
 * application could then commit a higher number before these rows (a client's cursor passes them for good) or read the
 * counter between the increment and the read here (one number twice). Answers the number of rows written.
 */
export async function applySqlSyncUpdate(
  run: SqlMigrationRun,
  dialect: 'mysql' | 'postgres',
  update: SqlSyncUpdate['syncUpdate'],
): Promise<number> {
  if (dialect === 'postgres') {
    return writeSyncUpdate(run, dialect, update);
  }
  await run({ params: [], text: 'START TRANSACTION' });
  try {
    const written = await writeSyncUpdate(run, dialect, update);
    await run({ params: [], text: 'COMMIT' });
    return written;
  } catch (error) {
    await run({ params: [], text: 'ROLLBACK' }).catch(() => undefined);
    throw error;
  }
}

async function writeSyncUpdate(
  run: SqlMigrationRun,
  dialect: 'mysql' | 'postgres',
  update: SqlSyncUpdate['syncUpdate'],
): Promise<number> {
  const quote = dialect === 'mysql' ? quoteMysqlIdentifier : quoteIdentifier;
  const table = quote(update.table);
  const id = quote('id');
  const { rows } = await run({
    params: [],
    text: `SELECT ${id} AS id FROM ${table} WHERE ${update.where} ORDER BY ${id} FOR UPDATE`,
  });
  const ids = rows.map((row) => String(row.id));
  if (!ids.length) {
    return 0;
  }
  const numbers =
    dialect === 'mysql'
      ? await mysqlNumbers(run, update.table, ids.length)
      : await postgresNumbers(run, update.table, ids.length);
  const bigint = dialect === 'mysql' ? '' : '::bigint';
  for (let start = 0; start < ids.length; start += SYNC_UPDATE_CHUNK) {
    const chunk = ids.slice(start, start + SYNC_UPDATE_CHUNK);
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const cases = chunk
      .map((row, index) => `WHEN ${param(row)} THEN ${param(numbers[start + index])}${bigint}`)
      .join(' ');
    const list = chunk.map((row) => param(row)).join(', ');
    await run({
      params,
      text:
        `UPDATE ${table} SET ${update.set}, ${quote('version')} = ${quote('version')} + 1, ` +
        `${quote('sync_seq')} = CASE ${id} ${cases} END WHERE ${id} IN (${list})`,
    });
  }
  return ids.length;
}

/** The next change numbers of a table on PostgreSQL, as the store takes them (advisory lock, then the sequence) */
async function postgresNumbers(run: SqlMigrationRun, table: string, count: number): Promise<string[]> {
  await run({
    params: [table],
    text: `SELECT pg_advisory_xact_lock(hashtext('lenne.tech:sync:' || current_schema() || '.' || $1))`,
  });
  const { rows } = await run({
    params: [syncSequenceName(table), count],
    text: `SELECT nextval(format('%I.%I', current_schema(), $1::text)::regclass)::text AS n FROM generate_series(1, $2::int)`,
  });
  return rows.map((row) => String(row.n)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

/** The next change numbers of a table on MySQL / MariaDB, as the store takes them (the counter row, last) */
async function mysqlNumbers(run: SqlMigrationRun, table: string, count: number): Promise<string[]> {
  await run({
    params: [count, table],
    text: `UPDATE ${quoteMysqlIdentifier(MYSQL_SYNC_COUNTERS)} SET \`seq\` = \`seq\` + $1 WHERE \`model\` = $2`,
  });
  const { rows } = await run({
    params: [table],
    text: `SELECT \`seq\` FROM ${quoteMysqlIdentifier(MYSQL_SYNC_COUNTERS)} WHERE \`model\` = $1`,
  });
  if (!rows.length) {
    throw new Error(`runSqlMigration(): ${table} is not the table of a synchronized model (no change counter)`);
  }
  const last = BigInt(rows[0].seq);
  return Array.from({ length: count }, (_, index) => (last - BigInt(count - 1 - index)).toString());
}
