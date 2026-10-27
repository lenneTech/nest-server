// Drizzle ORM 1.0.0-rc.5 + drizzle-kit 1.0.0-rc.5 against the same criteria as TypeORM and Kysely.
import { pushSchema } from 'drizzle-kit/api-postgres';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import pg from 'pg';

import { cases, connectMongo, people } from './09-shared-parity-fixture.mjs';
import { makeCompiler } from './where-compiler-factory.mjs';

const URL = 'postgres://proto_owner:proto@127.0.0.1:5434/proto';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const pool = new pg.Pool({ connectionString: URL, max: 20 });
const db = drizzle({ client: pool });

// ---- D3: query parity through Drizzle's `sql` tag (same compiler as Kysely, different tag) ----
const tag = Object.assign((s, ...v) => dsql(s, ...v), {
  ref: (c) => dsql.identifier(c), lit: (s) => dsql.raw(`'${s}'`), raw: (s) => dsql.raw(s), join: (a, sep) => dsql.join(a, sep),
});
const { compileWhere } = makeCompiler(tag);
await db.execute(dsql.raw('DROP TABLE IF EXISTS person; CREATE TABLE person (id text PRIMARY KEY, name text, age double precision, active boolean, created_at timestamptz, score double precision, tags jsonb, roles jsonb, address jsonb, contacts jsonb)'));
for (const x of people) {
  await pool.query('INSERT INTO person VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [x.id, x.name, x.age ?? null, x.active, x.createdAt, x.score ?? null,
    JSON.stringify(x.tags ?? []), JSON.stringify(x.roles ?? []), x.address === undefined ? null : JSON.stringify(x.address), x.contacts === undefined ? null : JSON.stringify(x.contacts)]);
}
const mongo = await connectMongo();
const mcoll = mongo.db('nest-server-proto-parity-drizzle').collection('person');
await mcoll.deleteMany({});
await mcoll.insertMany(people.map(({ id, ...rest }) => ({ _id: id, ...rest })));
let parityFails = 0;
for (const c of cases) {
  const m = (await mcoll.find(c.where).project({ _id: 1 }).toArray()).map((x) => x._id).sort();
  const r = await db.execute(dsql`SELECT id FROM person WHERE ${compileWhere(c.where)}`);
  const p = r.rows.map((x) => x.id).sort();
  if (JSON.stringify(m) !== JSON.stringify(p) && !c.differentByDesign) parityFails++;
}
check('D3 where parity via Drizzle sql tag (29 cases, 1 different-by-design)', parityFails === 0, `${parityFails} failures`);
await mongo.db('nest-server-proto-parity-drizzle').dropDatabase();
await mongo.close();

// ---- D5: atomic claim with onConflictDoUpdate + setWhere ----
const locks = pgTable('locks_drizzle', { key: text().primaryKey(), owner: text().notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull() });
await db.execute(dsql.raw('DROP TABLE IF EXISTS locks_drizzle; CREATE TABLE locks_drizzle (key text PRIMARY KEY, owner text NOT NULL, expires_at timestamptz NOT NULL)'));
let oneWinner = true;
for (let round = 0; round < 10; round++) {
  const res = await Promise.all(Array.from({ length: 16 }, (_, i) => db.insert(locks)
    .values({ key: `k${round}`, owner: `w${i}`, expiresAt: dsql`now() + interval '5 seconds'` })
    .onConflictDoUpdate({ target: locks.key, set: { owner: dsql`excluded.owner`, expiresAt: dsql`excluded.expires_at` }, setWhere: dsql`${locks.expiresAt} < now()` })
    .returning({ owner: locks.owner })));
  if (res.filter((r) => r.length).length !== 1) oneWinner = false;
}
check('D5 atomic claim: exactly one winner, 10 rounds x 16 workers', oneWinner);

// ---- D4: RLS per transaction, error without context ----
await db.execute(dsql.raw(`
  DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN DROP OWNED BY app_user; DROP ROLE app_user; END IF; END $$;
  CREATE ROLE app_user LOGIN PASSWORD 'app' NOBYPASSRLS;
  CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text LANGUAGE plpgsql STABLE AS $f$ DECLARE v text := current_setting('app.tenant_id', true); BEGIN IF v IS NULL OR v = '' THEN RAISE EXCEPTION 'tenant context missing' USING ERRCODE = 'insufficient_privilege'; END IF; RETURN v; END $f$;
  DROP TABLE IF EXISTS docs_drizzle; CREATE TABLE docs_drizzle (id text PRIMARY KEY, tenant_id text NOT NULL);
  INSERT INTO docs_drizzle VALUES ('d1','t1'),('d2','t1'),('d3','t2');
  ALTER TABLE docs_drizzle ENABLE ROW LEVEL SECURITY; ALTER TABLE docs_drizzle FORCE ROW LEVEL SECURITY;
  CREATE POLICY ti ON docs_drizzle USING (tenant_id = (SELECT app_current_tenant()));
  GRANT SELECT ON docs_drizzle TO app_user;`));
const appPool = new pg.Pool({ connectionString: 'postgres://app_user:app@127.0.0.1:5434/proto', max: 1 });
const appDb = drizzle({ client: appPool });
const docs = pgTable('docs_drizzle', { id: text().primaryKey(), tenantId: text('tenant_id').notNull() });
const seen = await appDb.transaction(async (tx) => {
  await tx.execute(dsql`SELECT set_config('app.tenant_id', ${'t1'}, true)`);
  return tx.select().from(docs);
});
check('D4 RLS: tenant t1 sees only its rows', seen.length === 2, String(seen.length));
let rlsErr;
try { await appDb.select().from(docs); } catch (e) { rlsErr = e; }
const code = rlsErr?.cause?.code ?? rlsErr?.code;
check('D4 RLS: no tenant context raises 42501', code === '42501', rlsErr ? `${rlsErr.constructor.name} ${code}` : 'NO ERROR');
await appPool.end();

// ---- D6: schema evolution from RUNTIME table definitions, with existing data ----
const v1 = { items: pgTable('evo_drizzle', { id: text().primaryKey(), title: text().notNull(), qty: text().notNull(), legacy: text() }) };
const v2 = {
  items: pgTable('evo_drizzle', {
    id: text().primaryKey(), name: text(), qty: integer(), note: text(), code: text(),
  }, (t) => [index('evo_drizzle_name_idx').on(t.name)]),
};
await db.execute(dsql.raw('DROP TABLE IF EXISTS evo_drizzle'));
const scope = { schemas: ['public'], tables: ['evo_drizzle'] };
const p1 = await pushSchema(v1, db, scope);
await p1.apply();
await db.execute(dsql.raw(`INSERT INTO evo_drizzle VALUES ('a','Alpha','1','x'),('b','Beta','2','y'),('c','Gamma','3',NULL)`));
let missing;
try { await pushSchema(v2, db, scope); } catch (e) { missing = e; }
check('D6 ambiguous change is REFUSED without hints (no guessing)', missing?.code === 'missing_hints', missing ? `${missing.code}: ${JSON.stringify(missing.missingHints)}` : 'NO ERROR - guessed');
// explicit hints: title was renamed to name; legacy dropped (confirm), note/code are new; qty type change confirmed
const hints = (missing?.missingHints ?? []).map((h) => {
  if (h.type === 'rename_or_create') {
    const ent = h.entity; // identifies the NEW entity
    const col = Array.isArray(ent) ? ent[ent.length - 1] : ent;
    if (col === 'name') return { type: 'rename', kind: h.kind, from: Array.isArray(ent) ? [...ent.slice(0, -1), 'title'] : 'title', to: ent };
    return { type: 'create', kind: h.kind, entity: ent };
  }
  return { type: 'confirm_data_loss', kind: h.kind, entity: h.entity };
});
// What a framework would derive from DECLARATIONS: renamedFrom on `name`, an explicit drop of `legacy`.
// Undeclared data loss is never confirmed — the loop stops and reports instead.
const declaredDrops = new Set(['legacy']);
let p2;
for (let round = 0; round < 5; round++) {
  try { p2 = await pushSchema(v2, db, scope, undefined, { hints }); break; } catch (e) {
    p2 = e;
    if (e?.code !== 'missing_hints') break;
    const undeclared = e.missingHints.filter((h) => h.type === 'confirm_data_loss' && !declaredDrops.has(h.entity.at(-1)));
    if (undeclared.length) break;
    for (const h of e.missingHints) hints.push({ type: 'confirm_data_loss', kind: h.kind, entity: h.entity });
  }
}
check('D6 hint rounds needed', true, `${hints.length} hints: ${hints.map((h) => `${h.type}:${(h.to ?? h.entity).at(-1)}`).join(', ')}`);
if (p2?.sqlStatements) {
  check('D6 with explicit hints: plan', true, p2.sqlStatements.join(' | '));
  try { await p2.apply(); } catch (e) { check('D6 apply', false, e.message.split('\n')[0]); }
  const rows = (await pool.query('SELECT * FROM evo_drizzle ORDER BY id')).rows;
  check('D6 renamed column kept its data', rows.map((r) => r.name).join(',') === 'Alpha,Beta,Gamma', JSON.stringify(rows));
} else {
  check('D6 with explicit hints', false, `${p2?.code ?? ''} ${p2?.message?.split('\n')[0]} ${JSON.stringify(p2?.missingHints ?? '')}`);
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(results.every((r) => r.ok) ? 'ALL PASS' : 'SOME FAILED');
await pool.end();
