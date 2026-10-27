// Fault injection: the defect class of drizzle #6114/#6341, checked for every adapter. A transaction whose
// statement hits pg's client-side query_timeout must neither LEAK the pooled client (pool exhausted, later
// queries hang) nor return a POISONED client (still inside the dead transaction) to the pool.
// Pool max is 2, so a single leak or poisoned client is observable.
import 'reflect-metadata';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { DataSource } from 'typeorm';

const URL = 'postgres://proto_owner:proto@127.0.0.1:5434/proto';
const poolCfg = (engine) => ({ connectionString: URL, max: 2, query_timeout: 200, application_name: `fault-${engine}` });

// GUARD=1: the framework-owned pool hygiene. A client handed back while still inside a transaction (status not
// 'I') or with a query in flight is released WITH an error, so pg-pool destroys it instead of re-using it.
// Wraps pool.connect because pg-pool binds client.release after emitting 'acquire'; covers the promise form
// (Kysely, Drizzle, pool.query) and the callback form (TypeORM).
const GUARD = process.env.GUARD === '1';
function guardPool(pool) {
  if (!GUARD) return pool;
  const connect = pool.connect.bind(pool);
  const unhealthy = (c) => ((c.getTransactionStatus() ?? 'I') !== 'I' || c._activeQuery ? new Error('released inside a transaction or with a query in flight') : undefined);
  const wrap = (client) => {
    const release = client.release;
    client.release = (err) => release(err ?? unhealthy(client));
    return client.release;
  };
  pool.connect = (cb) => (typeof cb === 'function'
    ? connect((err, client, release) => cb(err, client, err ? release : wrap(client)))
    : connect().then((client) => { wrap(client); return client; }));
  return pool;
}

// Adapters as a store would naively write them (same shape as 16), each running a transaction through its engine.
const ADAPTERS = {
  pg: async () => {
    const pool = guardPool(new pg.Pool(poolCfg('pg')));
    return {
      query: async (t, v) => (await pool.query(t, v)).rows,
      transaction: async (fn) => {
        const c = await pool.connect();
        let broken;
        try { await c.query('BEGIN'); const r = await fn((t, v) => c.query(t, v)); await c.query('COMMIT'); return r; }
        catch (e) { await c.query('ROLLBACK').catch((re) => { broken = re; }); broken ??= e; throw e; }
        finally { c.release(broken); } // the fix drizzle shipped: hand the error to the pool so it evicts the client
      },
      close: () => pool.end(),
    };
  },
  typeorm: async () => {
    const ds = await new DataSource({ type: 'postgres', url: URL, extra: { max: 2, query_timeout: 200, application_name: 'fault-typeorm' } }).initialize();
    guardPool(ds.driver.master);
    return {
      query: (t, v) => ds.query(t, v),
      transaction: async (fn) => {
        const qr = ds.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try { const r = await fn((t, v) => qr.query(t, v)); await qr.commitTransaction(); return r; }
        catch (e) { await qr.rollbackTransaction().catch(() => {}); throw e; }
        finally { await qr.release(); }
      },
      close: () => ds.destroy(),
    };
  },
  kysely: async () => {
    const db = new Kysely({ dialect: new PostgresDialect({ pool: guardPool(new pg.Pool(poolCfg('kysely'))) }) });
    return {
      query: async (t, v) => (await db.executeQuery(CompiledQuery.raw(t, v ?? []))).rows,
      transaction: (fn) => db.transaction().execute((tx) => fn((t, v) => tx.executeQuery(CompiledQuery.raw(t, v ?? [])))),
      close: () => db.destroy(),
    };
  },
  drizzle: async () => {
    const pool = guardPool(new pg.Pool(poolCfg('drizzle')));
    const db = drizzle({ client: pool });
    return {
      query: async (t) => (await db.execute(dsql.raw(t))).rows,
      transaction: (fn) => db.transaction((tx) => fn((t) => tx.execute(dsql.raw(t)))),
      close: () => pool.end(),
    };
  },
};

const admin = new pg.Pool({ connectionString: URL, max: 1 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withDeadline = (p, ms) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

const rows = [];
for (const [engine, make] of Object.entries(ADAPTERS)) {
  const ex = await make();
  // 1. four transactions that each time out mid-statement
  let timeouts = 0;
  for (let i = 0; i < 4; i++) {
    try { await ex.transaction(async (q) => { await q("SELECT set_config('app.tenant_id', 'leaky', true)"); await q('SELECT pg_sleep(0.6)'); }); }
    catch { timeouts++; }
  }
  await sleep(900); // let the server-side sleeps finish
  // 2. the pool must still serve queries (a leak with max 2 would hang here)
  const served = await withDeadline((async () => { for (let i = 0; i < 10; i++) await ex.query('SELECT 1'); })(), 3000);
  // 3. no connection of this adapter may still sit in a transaction, and no query may see the dead tx's setting
  const { rows: [{ n: stuck }] } = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND state LIKE 'idle in transaction%'", [`fault-${engine}`]);
  let leaked = false;
  if (served) for (let i = 0; i < 6; i++) if ((await ex.query("SELECT current_setting('app.tenant_id', true) AS v"))[0]?.v === 'leaky') leaked = true;
  rows.push({ engine, timeouts, served, stuck, leaked });
  await withDeadline(ex.close(), 3000);
}
await admin.end();

console.log('engine   timeouts  pool still serves  conns idle-in-tx  dead-tx setting visible');
for (const r of rows) console.log(`${r.engine.padEnd(8)} ${String(r.timeouts).padEnd(9)} ${(r.served ? 'ja' : 'NEIN (Leck)').padEnd(18)} ${String(r.stuck).padEnd(17)} ${r.leaked ? 'JA (vergiftet)' : 'nein'}`);
console.log(rows.every((r) => r.served && r.stuck === 0 && !r.leaked) ? 'ALL ADAPTERS SURVIVE TIMED-OUT TRANSACTIONS' : 'SOME ADAPTER LEAKS OR POISONS THE POOL');
process.exit(0);
