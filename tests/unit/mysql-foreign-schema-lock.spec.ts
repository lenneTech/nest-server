import { describe, expect, it, vi } from 'vitest';

import { sqlDialect } from '../../src/core/common/persistence/sql/sql-dialect';

import type { SqlExecutor, SqlStatement } from '../../src/core/common/persistence/sql/sql-executor.interface';

const TABLES = ['session', 'account', 'verification'];

/**
 * A lock connection that answers the schema lock, the catalog and the database's default collation, and records every
 * statement it runs
 */
function lockConnection(existingTables: number) {
  const statements: string[] = [];
  const answer = (statement: SqlStatement) => {
    statements.push(statement.text);
    if (/GET_LOCK/.test(statement.text)) {
      return [{ locked: 1 }];
    }
    if (/information_schema\.TABLES/.test(statement.text)) {
      return [{ n: String(existingTables) }];
    }
    if (/information_schema\.SCHEMATA/.test(statement.text)) {
      return [{ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }];
    }
    if (/@@SESSION\.lock_wait_timeout/.test(statement.text)) {
      return [{ timeout: 31536000 }];
    }
    return [];
  };
  const executor = {
    transaction: async (fn: (tx: any) => Promise<unknown>) =>
      fn({ run: async (statement: SqlStatement) => ({ rowCount: 0, rows: answer(statement) }) }),
  } as unknown as SqlExecutor;
  return { executor, statements };
}

describe('MySQL: the schema run of a library with tables of its own (Better-Auth)', () => {
  const dialect = sqlDialect({ appRole: 'nest_app', driver: 'mysql', isTenantIsolated: () => false });

  /**
   * @regression   DEV-3904 review — the switch of the database's default collation ran on every boot. On MySQL 8.4
   *   `ALTER DATABASE` takes an exclusive metadata lock on every table, so behind any open transaction it waited — with
   *   the server's `lock_wait_timeout` of a year — while every statement on the tables it had already locked stood still
   *   (measured: 2.8 s of stalled session lookups behind a 3 s transaction).
   * @seen-failing Switch the collation whether or not a table is missing in sql-dialect.ts — registered as mutation
   *   `mysql-collation-switch-every-boot` in tests/regression-mutations.json.
   */
  it('leaves the database alone when every table already exists', async () => {
    const { executor, statements } = lockConnection(TABLES.length);
    const migrate = vi.fn(async () => undefined);

    await dialect.withForeignSchemaLock(executor, TABLES, migrate);

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(statements.some((text) => /ALTER DATABASE/.test(text))).toBe(false);
  });

  it('creates missing tables in the framework collation, with a bounded wait, and restores the default', async () => {
    const { executor, statements } = lockConnection(TABLES.length - 1);
    const seenDuringMigration: string[] = [];
    const migrate = vi.fn(async () => {
      seenDuringMigration.push(...statements);
    });

    await dialect.withForeignSchemaLock(executor, TABLES, migrate);

    const alters = statements.filter((text) => /ALTER DATABASE/.test(text));
    expect(alters).toEqual([
      'ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
      'ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    ]);
    // The switch happened before the migration, the restore after it
    expect(seenDuringMigration.filter((text) => /ALTER DATABASE/.test(text))).toEqual([alters[0]]);
    // A long transaction makes the boot fail instead of freezing every table behind it
    const bounded = statements.findIndex((text) => /SET SESSION lock_wait_timeout = \d+/.test(text));
    expect(bounded).toBeGreaterThanOrEqual(0);
    expect(bounded).toBeLessThan(statements.indexOf(alters[0]));
    // ... and the connection gets its own timeout back
    expect(statements.at(-2)).toBe('SET SESSION lock_wait_timeout = 31536000');
  });
});
