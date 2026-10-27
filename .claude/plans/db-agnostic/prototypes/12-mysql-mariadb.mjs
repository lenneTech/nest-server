// Finalists Drizzle 1.0 RC and TypeORM 1.1 on MariaDB 11.8 and MySQL 8.4 — identical checks:
// runtime table, JSON round trip + JSON_CONTAINS, transaction rollback, atomic lease claim (16 workers),
// schema evolution with existing data (rename / type change / drop / add).
import 'reflect-metadata';
import { pushSchema } from 'drizzle-kit/payload/mysql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import { int, json, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';
import mysql from 'mysql2/promise';
import { DataSource, EntitySchema } from 'typeorm';

const TARGETS = [
  { name: 'MariaDB 11.8', type: 'mariadb', port: 3307 },
  { name: 'MySQL 8.4', type: 'mysql', port: 3308 },
];
const out = [];
const check = (who, name, ok, detail = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${who.padEnd(24)} ${name}${detail ? `  — ${detail}` : ''}`);

const claim = async (exec, table, key, owner) => {
  const ins = await exec(`INSERT IGNORE INTO ${table} (k, owner, expires_at) VALUES (?, ?, NOW() + INTERVAL 5 SECOND)`, [key, owner]);
  if (ins.affectedRows === 1) return true;
  const upd = await exec(`UPDATE ${table} SET owner = ?, expires_at = NOW() + INTERVAL 5 SECOND WHERE k = ? AND expires_at < NOW()`, [owner, key]);
  return upd.affectedRows === 1;
};

for (const t of TARGETS) {
  const url = `mysql://root:proto@127.0.0.1:${t.port}/proto`;
  // ---------------- Drizzle ----------------
  {
    const who = `Drizzle / ${t.name}`;
    const pool = mysql.createPool({ uri: url, connectionLimit: 20 });
    const db = drizzle({ client: pool });
    const docs = mysqlTable('docs_d', { id: varchar({ length: 24 }).primaryKey(), tags: json().$type(), title: text() });
    await db.execute(sql.raw('DROP TABLE IF EXISTS docs_d'));
    await db.execute(sql.raw('CREATE TABLE docs_d (id varchar(24) PRIMARY KEY, tags json, title text)'));
    await db.insert(docs).values([{ id: 'a', tags: ['x', 'y'], title: 'A' }, { id: 'b', tags: ['y'], title: 'B' }]);
    const back = await db.select().from(docs).where(sql`JSON_CONTAINS(${docs.tags}, ${JSON.stringify('x')})`);
    check(who, 'runtime table + JSON round trip + JSON_CONTAINS', back.length === 1 && Array.isArray(back[0].tags), JSON.stringify(back));
    try { await db.transaction(async (tx) => { await tx.insert(docs).values({ id: 'c', tags: [], title: 'C' }); throw new Error('rollback'); }); } catch { /* expected */ }
    check(who, 'transaction rollback', (await db.select().from(docs)).length === 2);
    await pool.query('DROP TABLE IF EXISTS locks_d');
    await pool.query('CREATE TABLE locks_d (k varchar(64) PRIMARY KEY, owner varchar(64) NOT NULL, expires_at datetime(3) NOT NULL)');
    let one = true;
    for (let r = 0; r < 10; r++) {
      const won = await Promise.all(Array.from({ length: 16 }, (_, i) => claim(async (q, p) => (await pool.query(q, p))[0], 'locks_d', `k${r}`, `w${i}`)));
      if (won.filter(Boolean).length !== 1) one = false;
    }
    check(who, 'atomic lease claim (10 x 16 workers, exactly one winner)', one);
    // schema evolution via drizzle-kit/api-mysql with explicit hints
    const v1 = { items: mysqlTable('evo_d', { id: varchar({ length: 24 }).primaryKey(), title: text().notNull(), qty: varchar({ length: 16 }).notNull(), legacy: text() }) };
    const v2 = { items: mysqlTable('evo_d', { id: varchar({ length: 24 }).primaryKey(), name: text(), qty: int(), note: text() }) };
    // payload/mysql pushSchema has no table filter: give the evolution a FRESH database per run (no drops needed)
    const evoName = `evo_${Date.now()}`;
    await pool.query(`CREATE DATABASE ${evoName}`);
    const evoPool = mysql.createPool({ uri: url.replace('/proto', `/${evoName}`), connectionLimit: 4 });
    const evoDb = { query: async (q, params) => (await evoPool.query(q, params))[0] };
    try {
      const p1 = await pushSchema(v1, evoDb, evoName);
      await p1.apply();
      await evoPool.query(`INSERT INTO evo_d VALUES ('a','Alpha','1','x'),('b','Beta','2','y')`);
      const hints = [];
      let plan;
      for (let round = 0; round < 6; round++) {
        try { plan = await pushSchema(v2, evoDb, evoName, undefined, { hints }); break; } catch (e) {
          if (e?.code !== 'missing_hints') { plan = e; break; }
          for (const h of e.missingHints) {
            const col = Array.isArray(h.entity) ? h.entity.at(-1) : h.entity;
            if (h.type === 'rename_or_create') hints.push(col === 'name' ? { type: 'rename', kind: h.kind, from: [...h.entity.slice(0, -1), 'title'], to: h.entity } : { type: 'create', kind: h.kind, entity: h.entity });
            else if (col === 'legacy' || col === 'qty') hints.push({ type: 'confirm_data_loss', kind: h.kind, entity: h.entity });
          }
        }
      }
      if (plan?.sqlStatements) {
        await plan.apply();
        const [rows] = await evoPool.query('SELECT * FROM evo_d ORDER BY id');
        check(who, 'schema evolution with hints: rename keeps data', rows.map((x) => x.name).join(',') === 'Alpha,Beta', `hints=${hints.map((h) => h.type + ':' + (h.to ?? h.entity).at(-1)).join(',')} rows=${JSON.stringify(rows)} plan=${plan.sqlStatements.join(' | ')}`);
      } else {
        check(who, 'schema evolution with hints', false, `${plan?.code ?? ''} ${String(plan?.message ?? plan).split('\n')[0]}`);
      }
    } catch (e) {
      check(who, 'schema evolution (drizzle-kit payload/mysql)', false, String(e?.message ?? e).split('\n')[0].slice(0, 200));
    }
    await evoPool.end();
    await pool.end();
  }
  // ---------------- TypeORM ----------------
  {
    const who = `TypeORM / ${t.name}`;
    const Doc = new EntitySchema({ name: 'Doc', tableName: 'docs_t', columns: { id: { type: 'varchar', length: 24, primary: true }, tags: { type: 'json' }, title: { type: 'text' } } });
    let ds = await new DataSource({ type: t.type, url, entities: [Doc], extra: { connectionLimit: 20 } }).initialize();
    await ds.query('DROP TABLE IF EXISTS docs_t');
    await ds.synchronize();
    await ds.getRepository('Doc').save([{ id: 'a', tags: ['x', 'y'], title: 'A' }, { id: 'b', tags: ['y'], title: 'B' }]);
    const back = await ds.getRepository('Doc').createQueryBuilder('d').where('JSON_CONTAINS(d.tags, :v)', { v: JSON.stringify('x') }).getMany();
    check(who, 'runtime EntitySchema + JSON round trip + JSON_CONTAINS', back.length === 1 && Array.isArray(back[0].tags), JSON.stringify(back));
    try { await ds.transaction(async (em) => { await em.getRepository('Doc').save({ id: 'c', tags: [], title: 'C' }); throw new Error('rollback'); }); } catch { /* expected */ }
    check(who, 'transaction rollback', (await ds.getRepository('Doc').count()) === 2);
    await ds.query('DROP TABLE IF EXISTS locks_t');
    await ds.query('CREATE TABLE locks_t (k varchar(64) PRIMARY KEY, owner varchar(64) NOT NULL, expires_at datetime(3) NOT NULL)');
    let one = true;
    for (let r = 0; r < 10; r++) {
      const won = await Promise.all(Array.from({ length: 16 }, (_, i) => claim((q, p) => ds.query(q, p), 'locks_t', `k${r}`, `w${i}`)));
      if (won.filter(Boolean).length !== 1) one = false;
    }
    check(who, 'atomic lease claim (10 x 16 workers, exactly one winner)', one);
    // schema evolution: what migration:generate / synchronize would do with existing data
    const E1 = new EntitySchema({ name: 'Evo', tableName: 'evo_t', columns: { id: { type: 'varchar', length: 24, primary: true }, title: { type: 'text' }, qty: { type: 'varchar', length: 16 }, legacy: { type: 'text', nullable: true } } });
    const E2 = new EntitySchema({ name: 'Evo', tableName: 'evo_t', columns: { id: { type: 'varchar', length: 24, primary: true }, name: { type: 'text', nullable: true }, qty: { type: 'int', nullable: true }, note: { type: 'text', nullable: true } } });
    await ds.destroy();
    ds = await new DataSource({ type: t.type, url, entities: [E1] }).initialize();
    await ds.query('DROP TABLE IF EXISTS evo_t');
    await ds.synchronize();
    await ds.query(`INSERT INTO evo_t VALUES ('a','Alpha','1','x'),('b','Beta','2','y')`);
    await ds.destroy();
    ds = await new DataSource({ type: t.type, url, entities: [E2] }).initialize();
    const plan = await ds.driver.createSchemaBuilder().log();
    await ds.synchronize();
    const rows = await ds.query('SELECT * FROM evo_t ORDER BY id');
    check(who, 'synchronize keeps data on rename/type change', rows.every((x) => x.name !== null && x.qty !== null), `plan=${plan.upQueries.map((q) => q.query.replace(/\s+/g, ' ')).join(' | ')} rows=${JSON.stringify(rows)}`);
    await ds.destroy();
  }
}
console.log(out.join('\n'));
