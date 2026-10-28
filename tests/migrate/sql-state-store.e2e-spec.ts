import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMigrationStore, MigrationRunner, SqlStateStore } from '../../src';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../helpers/postgres-test-db';

/**
 * Migration state and the migration run lock on PostgreSQL (`SqlStateStore`) — the contract `MongoStateStore` keeps on
 * MongoDB (`mongo-state-store.e2e-spec.ts`), as the owner of the tables.
 */
describe('SQL state store for migrations (e2e)', () => {
  let database: PostgresTestDatabase;
  let owner: Client;
  let dir: string;

  beforeAll(async () => {
    database = await createPostgresTestDatabase('migrations');
    owner = new Client({ connectionString: database.ownerUrl });
    await owner.connect();
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-sql-'));
    await owner.query('DROP TABLE IF EXISTS lt_migrations');
  });

  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  afterAll(async () => {
    await owner?.end();
    await database?.drop();
  });

  /** A migration that records every execution and stays busy long enough for a second runner to start it too */
  const writeSlowMigration = (marker: string, name = '1699000000001-concurrent.js') =>
    fs.writeFileSync(
      path.join(dir, name),
      `module.exports.up = async () => {
        require('fs').appendFileSync(${JSON.stringify(marker)}, 'up\\n');
        await new Promise((resolve) => setTimeout(resolve, 300));
      };\n`,
    );

  it('answers a first run with an empty state, and reads back what it saved', async () => {
    const store = new SqlStateStore(database.ownerUrl);
    expect(await store.loadAsync()).toEqual({});
    await store.saveAsync({ lastRun: 'a.js', migrations: [{ timestamp: 1, title: 'a.js' }] } as any);
    await store.saveAsync({
      lastRun: 'b.js',
      migrations: [
        { timestamp: 1, title: 'a.js' },
        { timestamp: 2, title: 'b.js' },
      ],
    } as any);
    expect(await store.loadAsync()).toEqual({
      lastRun: 'b.js',
      migrations: [
        { timestamp: 1, title: 'a.js' },
        { timestamp: 2, title: 'b.js' },
      ],
    });
    const { rows } = await owner.query('SELECT count(*)::int AS n FROM lt_migrations');
    expect(rows[0].n).toBe(1);
  });

  it('is what createMigrationStore() builds for a PostgreSQL URL', () => {
    const Store = createMigrationStore(database.ownerUrl);
    expect(new Store()).toBeInstanceOf(SqlStateStore);
  });

  /**
   * @regression   DEV-3830 (db-agnostic phase 2) — without a run lock, two replicas booting together both read the empty
   *   state and both apply the same migration.
   * @seen-failing Make SqlStateStore.withLock() run fn without the advisory lock in
   *   src/core/modules/migrate/sql-state-store.ts — registered as mutation `sql-migration-run-unlocked` in
   *   tests/regression-mutations.json.
   */
  it('applies a pending migration exactly once when replicas run up() at the same time', async () => {
    const marker = path.join(dir, 'executions.marker');
    writeSlowMigration(marker);
    const Store = createMigrationStore(database.ownerUrl);
    const runners = [new Store(), new Store(), new Store()].map(
      (stateStore) => new MigrationRunner({ migrationsDirectory: dir, stateStore }),
    );

    await Promise.all(runners.map((runner) => runner.up()));

    expect(fs.readFileSync(marker, 'utf-8')).toBe('up\n');
    const state = await new SqlStateStore(database.ownerUrl).loadAsync();
    expect(state.migrations.map((migration) => migration.title)).toEqual(['1699000000001-concurrent.js']);
  }, 30_000);

  it('releases the lock with the connection of a run that died, instead of blocking every later boot', async () => {
    const marker = path.join(dir, 'executions.marker');
    writeSlowMigration(marker);
    // A replica holds the run lock and is killed mid-run
    const dying = new Client({ connectionString: database.ownerUrl });
    await dying.connect();
    dying.on('error', () => undefined);
    await dying.query('BEGIN');
    await dying.query("SELECT pg_advisory_xact_lock(hashtext('lenne.tech:migrations'))");
    const { rows } = await dying.query('SELECT pg_backend_pid() AS pid');

    const run = new MigrationRunner({
      migrationsDirectory: dir,
      stateStore: new SqlStateStore(database.ownerUrl),
    }).up();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(marker)).toBe(false);

    await owner.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
    await run;
    expect(fs.readFileSync(marker, 'utf-8')).toBe('up\n');
  }, 30_000);
});
