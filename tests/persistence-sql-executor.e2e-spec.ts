import { sql } from 'drizzle-orm';
import { CompiledQuery } from 'kysely';
import { Client, DatabaseError, Pool, type PoolConfig } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseSqlEngine } from '../src/core/common/interfaces/server-options.interface';
import { createSqlExecutor } from '../src/core/common/persistence/sql/sql-executor.factory';
import type { SqlExecutor, SqlTenantScope } from '../src/core/common/persistence/sql/sql-executor.interface';
import { guardPool, isGuardedPool } from '../src/core/common/persistence/sql/sql-session';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './helpers/postgres-test-db';

/**
 * The SQL executor contract (plan §3.8, §3.10), against a real PostgreSQL as the APPLICATION role. Every engine
 * must pass the same cases: what a store operation does may not depend on which engine runs it.
 */
const ENGINES: DatabaseSqlEngine[] = ['typeorm', 'kysely', 'drizzle'];

const SETTINGS =
  "SELECT current_setting('app.tenant_scope', true) AS scope, current_setting('app.tenant_id', true) AS id, current_setting('app.tenant_ids', true) AS ids";
const TENANT_ID_SETTING = "SELECT current_setting('app.tenant_id', true) AS v";

/** The tenant setting, read through each engine's OWN API on the handle `native()` returned. */
const NATIVE_TENANT_ID: Record<DatabaseSqlEngine, (handle: any) => Promise<string>> = {
  drizzle: async (tx) => (await tx.execute(sql.raw(TENANT_ID_SETTING))).rows[0].v,
  kysely: async (trx) => (await trx.executeQuery(CompiledQuery.raw(TENANT_ID_SETTING))).rows[0].v,
  typeorm: async (manager) => (await manager.query(TENANT_ID_SETTING))[0].v,
};
const NATIVE_TXID: Record<DatabaseSqlEngine, (handle: any) => Promise<string>> = {
  drizzle: async (tx) => (await tx.execute(sql.raw('SELECT txid_current()::text AS x'))).rows[0].x,
  kysely: async (trx) => (await trx.executeQuery(CompiledQuery.raw('SELECT txid_current()::text AS x'))).rows[0].x,
  typeorm: async (manager) => (await manager.query('SELECT txid_current()::text AS x'))[0].x,
};

const NONE: SqlTenantScope = { kind: 'none' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const withDeadline = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
/** A session-level setting never written in this session reads NULL, one that only lived in a transaction ''. */
const UNSET = ['', null];

let database: PostgresTestDatabase;
let owner: Pool;
const runId = `${process.pid}`;

beforeAll(async () => {
  database = await createPostgresTestDatabase('sql-executor');
  owner = new Pool({ connectionString: database.ownerUrl, max: 2 });
  await owner.query('CREATE TABLE items (id text PRIMARY KEY, tenant_id text, label text)');
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON items TO "${new URL(database.appUrl).username}"`);
});

afterAll(async () => {
  await owner?.end();
  await database?.drop();
});

async function idleInTransaction(applicationName: string): Promise<number> {
  const { rows } = await owner.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND state LIKE 'idle in transaction%'",
    [applicationName],
  );
  return rows[0].n;
}

describe.each(ENGINES)('SQL executor contract — %s (e2e)', (engine) => {
  let executor: SqlExecutor;
  const applicationName = `lt-exec-${engine}-${runId}`;

  beforeAll(async () => {
    executor = await createSqlExecutor({ applicationName, engine, maxConnections: 4, url: database.appUrl });
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM items');
  });

  afterAll(async () => {
    await executor?.close();
  });

  it('reports its engine and runs as the application role', async () => {
    expect(executor.engine).toBe(engine);
    const { rows } = await executor.run<{ role: string }>({ params: [], text: 'SELECT current_user AS role' }, NONE);
    expect(rows[0].role).toBe(new URL(database.appUrl).username);
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — a tenant scope written for the session instead of the
   *   transaction outlives its statement, and the next request on that pooled connection reads the previous
   *   request's tenant.
   * @seen-failing Write the tenant id with `set_config(…, false)` in APPLY_SCOPE_SQL in
   *   src/core/common/persistence/sql/sql-session.ts — registered as mutation `sql-scope-outlives-transaction`
   *   in tests/regression-mutations.json.
   */
  it('applies the tenant scope to its statement and to nothing after it', async () => {
    const read = async (scope: SqlTenantScope) =>
      (await executor.run<{ id: string; ids: string; scope: string }>({ params: [], text: SETTINGS }, scope)).rows[0];

    expect(await read({ kind: 'tenant', tenantId: 't-1' })).toEqual({ id: 't-1', ids: '', scope: 'tenant' });
    expect(await read({ kind: 'tenants', tenantIds: ['a', 'b'] })).toEqual({
      id: '',
      ids: '["a","b"]',
      scope: 'tenants',
    });
    expect(await read({ kind: 'system' })).toEqual({ id: '', ids: '', scope: 'system' });
    expect(await read(NONE)).toEqual({ id: '', ids: '', scope: 'none' });

    // Every pooled connection afterwards, read without the framework: no scope survives its transaction.
    for (let i = 0; i < 8; i++) {
      await executor.run({ params: [], text: 'SELECT 1' }, { kind: 'tenant', tenantId: `leak-${i}` });
    }
    const pool = executor.driverPool as Pool;
    const seen = await Promise.all(Array.from({ length: 8 }, () => pool.query(TENANT_ID_SETTING)));
    for (const result of seen) {
      expect(UNSET).toContain(result.rows[0].v);
    }
  });

  it('binds positional parameters and reports the affected rows', async () => {
    const inserted = await executor.run(
      { params: ['i-1', 't-1', "it's $2"], text: 'INSERT INTO items (id, tenant_id, label) VALUES ($1, $2, $3)' },
      NONE,
    );
    expect(inserted.rowCount).toBe(1);
    const { rows } = await executor.run<{ label: string }>(
      { params: ['i-1'], text: 'SELECT label FROM items WHERE id = $1' },
      NONE,
    );
    expect(rows).toEqual([{ label: "it's $2" }]);
  });

  it('fails with the statement’s own error and leaves no connection inside a transaction', async () => {
    await expect(executor.run({ params: [], text: 'SELECT * FROM missing_table' }, NONE)).rejects.toMatchObject({
      code: '42P01',
    });
    expect(await idleInTransaction(applicationName)).toBe(0);
    const { rows } = await executor.run<{ one: number }>({ params: [], text: 'SELECT 1 AS one' }, NONE);
    expect(rows).toEqual([{ one: 1 }]);
  });

  it('binds array parameters as arrays, outside and inside a transaction', async () => {
    const statement = { params: [['x', 'y'], 'y'], text: 'SELECT $1::text[] AS list, $2 = ANY($1::text[]) AS found' };
    const expected = [{ found: true, list: ['x', 'y'] }];
    expect((await executor.run(statement, NONE)).rows).toEqual(expected);
    expect((await executor.transaction((tx) => tx.run(statement, NONE))).rows).toEqual(expected);
  });

  it('runs a transaction on one connection: commits together, rolls back when the callback throws', async () => {
    await executor.transaction(async (tx) => {
      await tx.run({ params: ['c-1'], text: "INSERT INTO items (id, label) VALUES ($1, 'first')" }, NONE);
      const { rows } = await tx.run<{ n: number }>({ params: [], text: 'SELECT count(*)::int AS n FROM items' }, NONE);
      expect(rows[0].n).toBe(1);
      await tx.run({ params: ['c-2'], text: "INSERT INTO items (id, label) VALUES ($1, 'second')" }, NONE);
    });
    expect((await owner.query('SELECT id FROM items ORDER BY id')).rows).toEqual([{ id: 'c-1' }, { id: 'c-2' }]);

    const failure = new Error('abort');
    await expect(
      executor.transaction(async (tx) => {
        await tx.run({ params: ['r-1'], text: 'INSERT INTO items (id) VALUES ($1)' }, NONE);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect((await owner.query("SELECT id FROM items WHERE id = 'r-1'")).rows).toEqual([]);
    expect(await idleInTransaction(applicationName)).toBe(0);
  });

  it('applies the scope of each statement inside a transaction', async () => {
    const seen = await executor.transaction(async (tx) => [
      (await tx.run<{ v: string }>({ params: [], text: TENANT_ID_SETTING }, { kind: 'tenant', tenantId: 'a' })).rows[0]
        .v,
      (await tx.run<{ v: string }>({ params: [], text: TENANT_ID_SETTING }, { kind: 'tenant', tenantId: 'b' })).rows[0]
        .v,
      (await tx.run<{ v: string }>({ params: [], text: TENANT_ID_SETTING }, NONE)).rows[0].v,
    ]);
    expect(seen).toEqual(['a', 'b', '']);
  });

  it('hands out the engine API bound to the transaction’s connection', async () => {
    await executor.transaction(async (tx) => {
      const { rows } = await tx.run<{ x: string }>(
        { params: [], text: 'SELECT txid_current()::text AS x' },
        { kind: 'tenant', tenantId: 'n-1' },
      );
      expect(await NATIVE_TXID[engine](tx.native())).toBe(rows[0].x);
      expect(await NATIVE_TENANT_ID[engine](tx.native())).toBe('n-1');
    });
  });

  it('fails inside a transaction with the same driver error as outside', async () => {
    const failure = await executor
      .transaction((tx) =>
        tx.run({ params: ['secret-param'], text: 'SELECT * FROM missing_table WHERE id = $1' }, NONE),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseError);
    expect(failure).toMatchObject({ code: '42P01' });
    expect((failure as Error).message).not.toContain('secret-param');
    expect(await idleInTransaction(applicationName)).toBe(0);
  });

  it('exposes the guarded node-postgres pool it runs on', async () => {
    const pool = executor.driverPool as Pool;
    expect(pool).toBeInstanceOf(Pool);
    expect(isGuardedPool(pool)).toBe(true);
    expect((await pool.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
  });

  it('survives statements that time out — no leaked, no poisoned connection (A10)', async () => {
    const faultName = `lt-exec-fault-${engine}-${runId}`;
    const faulty = await createSqlExecutor({
      applicationName: faultName,
      engine,
      maxConnections: 2,
      queryTimeoutMs: 200,
      url: database.appUrl,
    });
    try {
      let failures = 0;
      for (let i = 0; i < 4; i++) {
        await faulty
          .transaction(async (tx) => {
            await tx.run({ params: [], text: 'SELECT 1' }, { kind: 'tenant', tenantId: 'leaky' });
            await tx.run({ params: [], text: 'SELECT pg_sleep(0.6)' }, { kind: 'tenant', tenantId: 'leaky' });
          })
          .catch(() => failures++);
        await faulty
          .run({ params: [], text: 'SELECT pg_sleep(0.6)' }, { kind: 'tenant', tenantId: 'leaky' })
          .catch(() => failures++);
      }
      expect(failures).toBe(8);
      await sleep(900); // the server-side sleeps finish

      // A leak would exhaust the two connections and hang here.
      const served = await withDeadline(
        (async () => {
          for (let i = 0; i < 10; i++) {
            await faulty.run({ params: [], text: 'SELECT 1' }, NONE);
          }
        })(),
        3000,
      );
      expect(served).toBe(true);
      expect(await idleInTransaction(faultName)).toBe(0);
      const pool = faulty.driverPool as Pool;
      for (let i = 0; i < 6; i++) {
        expect(UNSET).toContain((await pool.query(TENANT_ID_SETTING)).rows[0].v);
      }
    } finally {
      await withDeadline(faulty.close(), 3000);
    }
  });
});

describe('SQL pool guard (e2e)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = guardPool(new Pool({ connectionString: database.appUrl, max: 1, pipeline: true } as PoolConfig));
  });

  afterAll(async () => {
    await pool?.end();
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1, A10) — an engine hands a connection back to the pool while it is
   *   still inside a transaction (Kysely 0.29 after a timeout), and the next request runs inside the dead
   *   transaction with the previous request's tenant.
   * @seen-failing Release without the health check in guardPool() in
   *   src/core/common/persistence/sql/sql-session.ts — registered as mutation `sql-pool-guard-reuses-dirty-client`
   *   in tests/regression-mutations.json.
   */
  it('destroys a connection released inside a transaction instead of re-using it (promise form)', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', 'leaky', true)");
    client.release();

    const { rows } = await pool.query(TENANT_ID_SETTING);
    expect(UNSET).toContain(rows[0].v);
  });

  it('destroys a connection released inside a transaction instead of re-using it (callback form)', async () => {
    await new Promise<void>((resolve, reject) => {
      pool.connect((error, client, release) => {
        if (error || !client) {
          reject(error);
          return;
        }
        client
          .query('BEGIN')
          .then(() => client.query("SELECT set_config('app.tenant_id', 'leaky', true)"))
          .then(() => {
            release();
            resolve();
          }, reject);
      });
    });

    const { rows } = await pool.query(TENANT_ID_SETTING);
    expect(UNSET).toContain(rows[0].v);
  });

  it('destroys a connection released with a pipelined transaction still in flight', async () => {
    const client = await pool.connect();
    const pending = Promise.allSettled([
      client.query('BEGIN'),
      client.query("SELECT set_config('app.tenant_id', 'leaky', true)"),
      client.query('SELECT pg_sleep(0.3)'),
    ]);
    client.release();

    const { rows } = await pool.query(TENANT_ID_SETTING);
    expect(UNSET).toContain(rows[0].v);
    await pending;
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — pg-pool listens for `error` only on idle connections. A
   *   connection that dies while checked out (terminated by the server, or destroyed by node-postgres when a
   *   pipelined query times out) emitted `error` with nobody listening, and Node ends the process on that.
   * @seen-failing Drop the checkout `error` listener in guardPool() in
   *   src/core/common/persistence/sql/sql-session.ts — registered as mutation
   *   `sql-pool-guard-unlistened-checkout-error` in tests/regression-mutations.json.
   */
  it('survives a connection that dies while checked out, and does not re-use it', async () => {
    const client = await pool.connect();
    expect(client.listenerCount('error')).toBeGreaterThan(0);
    const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
    const ended = new Promise((resolve) => client.once('end', resolve));

    const killer = new Client({ connectionString: database.appUrl });
    await killer.connect();
    try {
      await killer.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
    } finally {
      await killer.end();
    }
    await ended;
    client.release();

    const after = await pool.query('SELECT pg_backend_pid() AS pid');
    expect(after.rows[0].pid).not.toBe(rows[0].pid);
    expect(client.listenerCount('error')).toBeGreaterThan(0); // pg-pool's own listener, back after the release
  });

  it('listens for errors of idle connections where the pool has no listener of its own', async () => {
    expect(pool.listenerCount('error')).toBe(1);

    const own = new Pool({ connectionString: database.appUrl, max: 1 });
    const listener = () => undefined;
    own.on('error', listener);
    guardPool(own);
    expect(own.listeners('error')).toEqual([listener]);
    await own.end();
  });

  it('keeps re-using a healthy connection', async () => {
    const first = await pool.query('SELECT pg_backend_pid() AS pid');
    const second = await pool.query('SELECT pg_backend_pid() AS pid');
    expect(second.rows[0].pid).toBe(first.rows[0].pid);
  });

  it('wraps a pool only once', () => {
    const connect = pool.connect;
    expect(guardPool(pool)).toBe(pool);
    expect(pool.connect).toBe(connect);
  });
});
