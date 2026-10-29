// Fair overhead benchmark on Postgres 18: raw pg (baseline) vs Kysely vs Drizzle vs TypeORM.
// Same pool size (10), same concurrency (10), same SQL shapes; 3 runs per engine, median per phase.
import 'reflect-metadata';
import { eq as deq, gt as dgt, and as dand, sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { Kysely, PostgresDialect, sql as ksql } from 'kysely';
import pg from 'pg';
import { DataSource, EntitySchema } from 'typeorm';

const URL = 'postgres://proto_owner:proto@127.0.0.1:5434/proto';
const N_SINGLE = 2000, N_BATCH = 20, BATCH = 100, N_GET = 3000, N_FILTER = 1000, N_UPDATE = 2000, CONC = 10;
const runConc = async (n, fn) => { let i = 0; await Promise.all(Array.from({ length: CONC }, async () => { while (i < n) { const k = i++; await fn(k); } })); };
const time = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t; };
const row = (p, k) => ({ id: `${p}${k}`, name: `n${k}`, age: k % 90, tags: [`t${k % 7}`, `t${(k + 3) % 7}`], createdAt: new Date() });

const admin = new pg.Pool({ connectionString: URL, max: 2 });
const reset = () => admin.query('DROP TABLE IF EXISTS bench; CREATE TABLE bench (id text PRIMARY KEY, name text, age integer, tags jsonb, created_at timestamptz); CREATE INDEX ON bench (age)');

const engines = {
  'pg (raw)': async () => {
    const pool = new pg.Pool({ connectionString: URL, max: CONC });
    return {
      insertOne: (r) => pool.query('INSERT INTO bench (id,name,age,tags,created_at) VALUES ($1,$2,$3,$4,$5)', [r.id, r.name, r.age, JSON.stringify(r.tags), r.createdAt]),
      insertMany: (rs) => pool.query(`INSERT INTO bench (id,name,age,tags,created_at) SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text, name text, age int, tags jsonb, created_at timestamptz)`, [JSON.stringify(rs.map((r) => ({ ...r, created_at: r.createdAt })))]),
      get: (id) => pool.query('SELECT * FROM bench WHERE id = $1', [id]),
      filter: (age, tag) => pool.query('SELECT * FROM bench WHERE age > $1 AND tags @> $2::jsonb LIMIT 50', [age, JSON.stringify([tag])]),
      update: (id, name) => pool.query('UPDATE bench SET name = $1 WHERE id = $2', [name, id]),
      close: () => pool.end(),
    };
  },
  Kysely: async () => {
    const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: URL, max: CONC }) }) });
    const map = (r) => ({ id: r.id, name: r.name, age: r.age, tags: JSON.stringify(r.tags), created_at: r.createdAt });
    return {
      insertOne: (r) => db.insertInto('bench').values(map(r)).execute(),
      insertMany: (rs) => db.insertInto('bench').values(rs.map(map)).execute(),
      get: (id) => db.selectFrom('bench').selectAll().where('id', '=', id).executeTakeFirst(),
      filter: (age, tag) => db.selectFrom('bench').selectAll().where('age', '>', age).where(ksql`tags @> ${JSON.stringify([tag])}::jsonb`).limit(50).execute(),
      update: (id, name) => db.updateTable('bench').set({ name }).where('id', '=', id).execute(),
      close: () => db.destroy(),
    };
  },
  Drizzle: async () => {
    const pool = new pg.Pool({ connectionString: URL, max: CONC });
    const db = drizzle({ client: pool });
    const t = pgTable('bench', { id: text().primaryKey(), name: text(), age: integer(), tags: jsonb(), createdAt: timestamp('created_at', { withTimezone: true }) });
    return {
      insertOne: (r) => db.insert(t).values(r),
      insertMany: (rs) => db.insert(t).values(rs),
      get: (id) => db.select().from(t).where(deq(t.id, id)).limit(1),
      filter: (age, tag) => db.select().from(t).where(dand(dgt(t.age, age), dsql`${t.tags} @> ${JSON.stringify([tag])}::jsonb`)).limit(50),
      update: (id, name) => db.update(t).set({ name }).where(deq(t.id, id)),
      close: () => pool.end(),
    };
  },
  TypeORM: async () => {
    const Bench = new EntitySchema({ name: 'Bench', tableName: 'bench', columns: { id: { type: 'text', primary: true }, name: { type: 'text' }, age: { type: 'int' }, tags: { type: 'jsonb' }, createdAt: { name: 'created_at', type: 'timestamptz' } } });
    const ds = await new DataSource({ type: 'postgres', url: URL, entities: [Bench], extra: { max: CONC } }).initialize();
    const repo = ds.getRepository('Bench');
    return {
      insertOne: (r) => repo.insert(r),
      insertMany: (rs) => repo.insert(rs),
      get: (id) => repo.findOneBy({ id }),
      filter: (age, tag) => repo.createQueryBuilder('b').where('b.age > :age', { age }).andWhere('b.tags @> :tag::jsonb', { tag: JSON.stringify([tag]) }).limit(50).getMany(),
      update: (id, name) => repo.update({ id }, { name }),
      close: () => ds.destroy(),
    };
  },
  'TypeORM raw': async () => {
    // how a framework store would use TypeORM: own compiled SQL, plain rows, no entity hydration
    const ds = await new DataSource({ type: 'postgres', url: URL, extra: { max: CONC } }).initialize();
    return {
      insertOne: (r) => ds.query('INSERT INTO bench (id,name,age,tags,created_at) VALUES ($1,$2,$3,$4,$5)', [r.id, r.name, r.age, JSON.stringify(r.tags), r.createdAt]),
      insertMany: (rs) => ds.query(`INSERT INTO bench (id,name,age,tags,created_at) SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text, name text, age int, tags jsonb, created_at timestamptz)`, [JSON.stringify(rs.map((r) => ({ ...r, created_at: r.createdAt })))]),
      get: (id) => ds.query('SELECT * FROM bench WHERE id = $1', [id]),
      filter: (age, tag) => ds.query('SELECT * FROM bench WHERE age > $1 AND tags @> $2::jsonb LIMIT 50', [age, JSON.stringify([tag])]),
      update: (id, name) => ds.query('UPDATE bench SET name = $1 WHERE id = $2', [name, id]),
      close: () => ds.destroy(),
    };
  },
};

const phases = ['insertOne', 'insertMany', 'get', 'filter', 'update'];
const results = {};
for (const [name, make] of Object.entries(engines)) {
  const runs = [];
  for (let run = 0; run < 3; run++) {
    await reset();
    const e = await make();
    const r = {};
    r.insertOne = await time(() => runConc(N_SINGLE, (k) => e.insertOne(row('s', k))));
    r.insertMany = await time(async () => { for (let b = 0; b < N_BATCH; b++) await e.insertMany(Array.from({ length: BATCH }, (_, j) => row('b', b * BATCH + j))); });
    r.get = await time(() => runConc(N_GET, (k) => e.get(`s${k % N_SINGLE}`)));
    r.filter = await time(() => runConc(N_FILTER, (k) => e.filter(k % 80, `t${k % 7}`)));
    r.update = await time(() => runConc(N_UPDATE, (k) => e.update(`s${k % N_SINGLE}`, `u${k}`)));
    await e.close();
    runs.push(r);
  }
  results[name] = Object.fromEntries(phases.map((p) => [p, runs.map((x) => x[p]).sort((a, b) => a - b)[1]]));
}
const base = results['pg (raw)'];
console.log(`ops: insertOne ${N_SINGLE}, insertMany ${N_BATCH}x${BATCH}, get ${N_GET}, filter ${N_FILTER} (jsonb @> + range, limit 50), update ${N_UPDATE}; concurrency ${CONC}; median of 3 (ms, factor vs raw pg)`);
console.log(['engine'.padEnd(10), ...phases.map((p) => p.padStart(16))].join(''));
for (const [name, r] of Object.entries(results)) {
  console.log([name.padEnd(10), ...phases.map((p) => `${r[p].toFixed(0)} (${(r[p] / base[p]).toFixed(2)}x)`.padStart(16))].join(''));
}
await admin.end();
