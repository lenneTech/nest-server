// Can the SQL engine be switched by CONFIGURATION alone? One store scenario, one where compiler, one executor
// port with four adapters (raw pg, TypeORM, Kysely, Drizzle). The scenario code below the adapters never names an
// engine; only the `engine` string differs per run. Checks per engine:
//   1. the 29 parity cases (same compiled SQL) return what MongoDB returns
//   2. transaction rollback
//   3. the engine's NATIVE handle inside a store transaction runs on the SAME connection (sees set_config)
//   4. the transaction-local setting is gone afterwards
//   5. the engine's native query builder works outside a transaction
//   6. the adapter exposes the driver pool Better-Auth needs
import 'reflect-metadata';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { CompiledQuery, Kysely, PostgresDialect, sql as ksql } from 'kysely';
import pg from 'pg';
import { DataSource } from 'typeorm';

import { cases, connectMongo, people } from './09-shared-parity-fixture.mjs';
import { compile } from './where-compiler-string.mjs';

const URL = 'postgres://proto_owner:proto@127.0.0.1:5434/proto';

// ---------------------------------------------------------------------------------------------
// Executor port: query(text, values) -> rows, transaction(fn({ query, native })), native, pool, close
// Each adapter also knows how to use ITS OWN API (only the test calls these, to prove native access).
// ---------------------------------------------------------------------------------------------
const ADAPTERS = {
  pg: async (url) => {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const run = (c) => async (t, v) => (await c.query(t, v)).rows;
    return {
      query: run(pool), native: pool, pool, close: () => pool.end(),
      transaction: async (fn) => {
        const c = await pool.connect();
        try { await c.query('BEGIN'); const r = await fn({ query: run(c), native: c }); await c.query('COMMIT'); return r; }
        catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      },
      nativeSetting: async (h) => (await h.query("SELECT current_setting('app.tenant_id', true) AS v")).rows[0].v,
      nativeCount: async (h) => Number((await h.query('SELECT count(*) AS n FROM person_sw')).rows[0].n),
    };
  },
  typeorm: async (url) => {
    const ds = await new DataSource({ type: 'postgres', url, extra: { max: 10 } }).initialize();
    return {
      query: (t, v) => ds.query(t, v), native: ds, pool: ds.driver.master, close: () => ds.destroy(),
      transaction: async (fn) => {
        const qr = ds.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try { const r = await fn({ query: (t, v) => qr.query(t, v), native: qr.manager }); await qr.commitTransaction(); return r; }
        catch (e) { await qr.rollbackTransaction(); throw e; } finally { await qr.release(); }
      },
      nativeSetting: async (h) => (await h.createQueryBuilder().select("current_setting('app.tenant_id', true)", 'v').from('person_sw', 't').limit(1).getRawOne()).v,
      nativeCount: async (h) => Number((await h.createQueryBuilder().select('count(*)', 'n').from('person_sw', 't').getRawOne()).n),
    };
  },
  kysely: async (url) => {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const run = (h) => async (t, v) => (await h.executeQuery(CompiledQuery.raw(t, v ?? []))).rows;
    return {
      query: run(db), native: db, pool, close: () => db.destroy(),
      transaction: (fn) => db.transaction().execute((tx) => fn({ query: run(tx), native: tx })),
      nativeSetting: async (h) => (await h.selectFrom('person_sw').select(ksql`current_setting('app.tenant_id', true)`.as('v')).limit(1).executeTakeFirst()).v,
      nativeCount: async (h) => Number((await h.selectFrom('person_sw').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    };
  },
  drizzle: async (url) => {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzle({ client: pool });
    // positional text + values -> Drizzle SQL object (placeholders become bound params again)
    const toSql = (t, v = []) => dsql.join(t.split(/\$(\d+)/).map((s, i) => (i % 2 ? dsql`${v[Number(s) - 1]}` : dsql.raw(s))), dsql.raw(''));
    const run = (h) => async (t, v) => (await h.execute(toSql(t, v))).rows;
    return {
      query: run(db), native: db, pool, close: () => pool.end(),
      transaction: (fn) => db.transaction((tx) => fn({ query: run(tx), native: tx })),
      nativeSetting: async (h) => (await h.execute(dsql`SELECT current_setting('app.tenant_id', true) AS v`)).rows[0].v,
      nativeCount: async (h) => Number((await h.execute(dsql`SELECT count(*) AS n FROM person_sw`)).rows[0].n),
    };
  },
};

// named :pN -> positional $n (the only dialect step between the compiler and any Postgres executor)
const positional = ({ text, params }) => {
  const values = [];
  return { text: text.replace(/:(p\d+)\b/g, (_, k) => { values.push(params[k]); return `$${values.length}`; }), values };
};

// ---------------------------------------------------------------------------------------------
// Expected results from MongoDB, computed once
// ---------------------------------------------------------------------------------------------
const mongo = await connectMongo();
const mcoll = mongo.db('nest-server-proto-engine-switch').collection('person');
await mcoll.deleteMany({});
await mcoll.insertMany(people.map(({ id, ...rest }) => ({ _id: id, ...rest })));
const expected = [];
for (const c of cases) expected.push((await mcoll.find(c.where).project({ _id: 1 }).toArray()).map((x) => x._id).sort());
await mongo.db('nest-server-proto-engine-switch').dropDatabase();
await mongo.close();

// ---------------------------------------------------------------------------------------------
// The scenario: engine-agnostic store code
// ---------------------------------------------------------------------------------------------
const report = [];
for (const engine of Object.keys(ADAPTERS)) {
  const config = { database: { url: URL, sqlEngine: engine } };
  const ex = await ADAPTERS[config.database.sqlEngine](config.database.url);
  const res = { engine };

  await ex.query('DROP TABLE IF EXISTS person_sw');
  await ex.query('CREATE TABLE person_sw (id text PRIMARY KEY, name text, age double precision, active boolean, created_at timestamptz, score double precision, tags jsonb, roles jsonb, address jsonb, contacts jsonb)');
  for (const x of people) {
    await ex.query('INSERT INTO person_sw VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [x.id, x.name, x.age ?? null, x.active, x.createdAt, x.score ?? null,
      JSON.stringify(x.tags ?? []), JSON.stringify(x.roles ?? []), x.address === undefined ? null : JSON.stringify(x.address), x.contacts === undefined ? null : JSON.stringify(x.contacts)]);
  }

  // 1. parity
  let ok = 0, diff = 0, fail = 0;
  for (const [i, c] of cases.entries()) {
    const { text, values } = positional(compile(c.where));
    const got = (await ex.query(`SELECT t.id FROM person_sw t WHERE ${text}`, values)).map((r) => r.id).sort();
    if (JSON.stringify(got) === JSON.stringify(expected[i])) ok++; else if (c.differentByDesign) diff++; else fail++;
  }
  res.parity = `${ok}/${cases.length}${diff ? ` +${diff} by design` : ''}${fail ? ` FAIL ${fail}` : ''}`;
  res.parityOk = fail === 0;

  // 2. rollback
  try { await ex.transaction(async (tx) => { await tx.query('INSERT INTO person_sw (id, name) VALUES ($1, $2)', ['zz', 'Z']); throw new Error('rollback'); }); } catch { /* expected */ }
  res.rollback = Number((await ex.query('SELECT count(*) AS n FROM person_sw'))[0].n) === people.length;

  // 3. native handle inside the store transaction shares its connection
  const tenant = `tenant-${engine}`;
  res.nativeInTx = await ex.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    return (await ex.nativeSetting(tx.native)) === tenant;
  });

  // 4. transaction-local setting is gone afterwards
  res.settingReset = !(await ex.query("SELECT current_setting('app.tenant_id', true) AS v"))[0].v;

  // 5. native builder outside a transaction
  res.nativeOutside = (await ex.nativeCount(ex.native)) === people.length;

  // 6. driver pool for Better-Auth
  res.poolForBetterAuth = (await ex.pool.query('SELECT 1 AS one')).rows[0].one === 1;

  await ex.query('DROP TABLE person_sw');
  await ex.close();
  report.push(res);
}

const yes = (b) => (b ? 'ja' : 'NEIN');
console.log('engine   parity (vs MongoDB)   rollback  native-in-tx  tx-local reset  native builder  pool for Better-Auth');
for (const r of report) {
  console.log(`${r.engine.padEnd(8)} ${r.parity.padEnd(21)} ${yes(r.rollback).padEnd(9)} ${yes(r.nativeInTx).padEnd(13)} ${yes(r.settingReset).padEnd(15)} ${yes(r.nativeOutside).padEnd(15)} ${yes(r.poolForBetterAuth)}`);
}
const all = report.every((r) => r.parityOk && r.rollback && r.nativeInTx && r.settingReset && r.nativeOutside && r.poolForBetterAuth);
console.log(all ? 'ALL ENGINES PASS WITH IDENTICAL STORE CODE' : 'SOME ENGINE FAILED');
