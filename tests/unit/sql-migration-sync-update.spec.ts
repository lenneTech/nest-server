import { describe, expect, it } from 'vitest';

import { applySqlSyncUpdate, type SqlMigrationRun } from '../../src/core/modules/migrate/sql-migration.helper';

/**
 * The statements `runSqlMigration()` sends for a `syncUpdate`, recorded on a fake connection. What runs them on a real
 * database — the numbers, the version, the conflict a client meets afterwards — is the `migration-sync-update` case of
 * `tests/sync-contract.e2e-spec.ts` on every SQL column; this spec pins the transaction around them on MySQL / MariaDB,
 * which no single-client test can observe.
 */
function recorder(rows: Record<string, any[]> = {}) {
  const statements: string[] = [];
  const run: SqlMigrationRun = async ({ text }) => {
    statements.push(text);
    const match = Object.keys(rows).find((prefix) => text.startsWith(prefix));
    return { rows: match ? rows[match] : [] };
  };
  return { run, statements };
}

const update = { set: '`title` = 1', table: 'sync_notes', where: '1=1' };

describe('runSqlMigration() syncUpdate', () => {
  /**
   * @regression   DEV-3902 review — a DDL statement before a `syncUpdate` commits the migration's transaction on MySQL /
   *   MariaDB; in autocommit the row locks and the counter lock ended with each statement, so a running application
   *   could commit a higher change number before the migrated rows (a client's cursor passed them for good) or read
   *   the counter between its increment and the read (one number twice).
   * @seen-failing Drop the transaction around the MySQL branch of applySqlSyncUpdate() in
   *   src/core/modules/migrate/sql-migration.helper.ts — registered as mutation `sync-migration-update-autocommit` in
   *   tests/regression-mutations.json.
   */
  it('locks, numbers and writes the rows in one transaction of their own on MySQL / MariaDB', async () => {
    const { run, statements } = recorder({
      'SELECT `id`': [{ id: 'a' }, { id: 'b' }],
      'SELECT `seq`': [{ seq: '12' }],
    });
    expect(await applySqlSyncUpdate(run, 'mysql', update)).toBe(2);
    expect(statements[0]).toBe('START TRANSACTION');
    expect(statements[1]).toMatch(/^SELECT `id` AS id FROM `sync_notes` WHERE 1=1 ORDER BY `id` FOR UPDATE$/);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.slice(1, -1).some((text) => text.startsWith('UPDATE `sync_notes` SET'))).toBe(true);
  });

  it('rolls the transaction back when a statement fails, and reports the failure', async () => {
    const statements: string[] = [];
    const run: SqlMigrationRun = async ({ text }) => {
      statements.push(text);
      if (text.startsWith('UPDATE `lt_sync_counters`')) {
        throw new Error('lock wait timeout');
      }
      return { rows: text.startsWith('SELECT `id`') ? [{ id: 'a' }] : [] };
    };
    await expect(applySqlSyncUpdate(run, 'mysql', update)).rejects.toThrow('lock wait timeout');
    expect(statements[0]).toBe('START TRANSACTION');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('runs inside the migration transaction on PostgreSQL, which no DDL statement ends', async () => {
    const { run, statements } = recorder({ 'SELECT "id"': [{ id: 'a' }], 'SELECT nextval': [{ n: '7' }] });
    expect(await applySqlSyncUpdate(run, 'postgres', { ...update, set: '"title" = 1' })).toBe(1);
    expect(statements).not.toContain('START TRANSACTION');
    expect(statements).not.toContain('COMMIT');
  });
});
