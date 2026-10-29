import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The migrate CLI builds its PostgreSQL state store from a URL alone (`createMigrationStore(ownerUrl)`), outside the
 * application, where no `database.sqlEngine` can be read. A project installs only the engine it chose — so the store
 * must run on the one that is there, not on the framework's default.
 */
describe('SQL migration state store without a configured engine', () => {
  /** A project that installed Kysely but not TypeORM */
  const withoutTypeOrm = () =>
    vi.doMock('typeorm', () => {
      throw new Error("Cannot find package 'typeorm'");
    });

  afterEach(() => {
    vi.doUnmock('typeorm');
    vi.doUnmock('../../src/core/common/persistence/sql/sql-executor.factory');
    vi.resetModules();
  });

  it('finds the first installed engine, in the framework order', async () => {
    withoutTypeOrm();
    const { installedSqlEngine } = await import('../../src/core/common/persistence/sql/sql-executor.factory');

    expect(await installedSqlEngine()).toBe('kysely');
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — SqlStateStore fell back to `typeorm` when no engine was given, so
   *   `createMigrationStore(ownerUrl)` failed every `migrate up/down/list` (and the container entrypoint) of a project
   *   on Kysely or Drizzle with "typeorm is not installed".
   * @seen-failing Fall back to `'typeorm'` instead of installedSqlEngine() in SqlStateStore.open() in
   *   src/core/modules/migrate/sql-state-store.ts — registered as mutation `sql-state-store-assumes-typeorm` in
   *   tests/regression-mutations.json.
   */
  it('opens its connection on the installed engine when the project did not name one', async () => {
    withoutTypeOrm();
    const opened: { engine: string }[] = [];
    vi.doMock('../../src/core/common/persistence/sql/sql-executor.factory', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      createSqlExecutor: async (options: { engine: string }) => {
        opened.push(options);
        return { close: async () => undefined, run: async () => ({ rowCount: 0, rows: [] }) };
      },
    }));
    const { createMigrationStore } = await import('../../src/core/modules/migrate/migration.helper');

    const Store = createMigrationStore('postgres://owner@localhost:5432/project');
    await new Store().loadAsync();

    expect(opened.map((options) => options.engine)).toEqual(['kysely']);
  });
});
