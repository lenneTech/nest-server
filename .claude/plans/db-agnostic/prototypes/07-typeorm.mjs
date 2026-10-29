// TypeORM 1.1.2 against the same criteria as Kysely: runtime EntitySchema from neutral metadata,
// DDL + diff, dynamic where (JSONB/array semantics), RLS per transaction, atomic claim, undefined-in-where.
import 'reflect-metadata';
import { DataSource, EntitySchema } from 'typeorm';

const URL = 'postgres://proto_owner:proto@127.0.0.1:5434/proto';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// ---- neutral metadata (same shape as prototype 04) -> EntitySchema ----
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const colType = { id: 'text', string: 'text', number: 'double precision', boolean: 'boolean', date: 'timestamptz', ref: 'text', json: 'jsonb' };
const meta = (extra = {}) => ({
  name: 'Invoice', table: 'invoices_typeorm',
  fields: { id: { kind: 'id' }, number: { kind: 'string' }, total: { kind: 'number' }, paid: { kind: 'boolean', default: false },
    issuedAt: { kind: 'date', index: true }, customer: { kind: 'ref' }, lines: { kind: 'json' }, tags: { kind: 'json' }, tenantId: { kind: 'string' }, ...extra },
  compound: [{ fields: ['tenantId', 'number'], unique: true }],
});
const toSchema = (m) => new EntitySchema({
  name: m.name, tableName: m.table,
  columns: Object.fromEntries(Object.entries(m.fields).map(([k, f]) => [k, {
    name: snake(k), type: colType[f.kind], primary: f.kind === 'id' || undefined, nullable: !!f.optional,
    default: f.default, createDate: false,
  }])),
  indices: [
    ...Object.entries(m.fields).filter(([, f]) => f.index || f.kind === 'ref').map(([k]) => ({ name: `${m.table}_${snake(k)}_idx`, columns: [k] })),
    ...m.compound.map((c) => ({ name: `${m.table}_${c.fields.map(snake).join('_')}_uq`, columns: c.fields, unique: c.unique })),
  ],
});

const ds = async (m, opts = {}) => new DataSource({ type: 'postgres', url: URL, entities: [toSchema(m)], synchronize: false, logging: false, ...opts }).initialize();

// T2: DDL + additive diff from runtime metadata
let d1 = await ds(meta());
await d1.query('DROP TABLE IF EXISTS invoices_typeorm');
const create = await d1.driver.createSchemaBuilder().log();
await d1.synchronize();
await d1.destroy();
const d2 = await ds(meta({ note: { kind: 'string', optional: true }, dueAt: { kind: 'date', optional: true, index: true } }));
const diff = await d2.driver.createSchemaBuilder().log();
check('T2 DDL from runtime EntitySchema', create.upQueries.length > 0, `${create.upQueries.length} up-queries`);
check('T2 additive diff v1->v2', diff.upQueries.length > 0, diff.upQueries.map((q) => q.query).join(' | '));
await d2.synchronize();

// seed
const repo = d2.getRepository('Invoice');
await repo.save([
  { id: 'i1', number: 'A-1', total: 10, paid: true, issuedAt: new Date('2026-01-01'), customer: 'c1', lines: [{ sku: 'x', qty: 1 }], tags: ['a', 'b'], tenantId: 't1' },
  { id: 'i2', number: 'A-2', total: 20, paid: false, issuedAt: new Date('2026-02-01'), customer: 'c2', lines: [], tags: ['b'], tenantId: 't1', note: null },
  { id: 'i3', number: 'B-1', total: 30, paid: false, issuedAt: new Date('2026-03-01'), customer: 'c1', lines: [{ sku: 'y', qty: 3 }], tags: [], tenantId: 't2', note: 'x' },
]);

// T3: dynamic where through the query builder (named params; JSONB + array + null semantics)
const q = (where, params) => d2.getRepository('Invoice').createQueryBuilder('t').select('t.id', 'id').where(where, params).orderBy('t.id').getRawMany().then((r) => r.map((x) => x.id));
check('T3 array contains (tags @> ["a"])', JSON.stringify(await q('t.tags @> :v::jsonb', { v: JSON.stringify(['a']) })) === '["i1"]');
check('T3 $ne with missing/null like Mongo (IS DISTINCT FROM)', JSON.stringify(await q('t.note IS DISTINCT FROM :v', { v: 'x' })) === '["i1","i2"]');
check('T3 $in with spread params', JSON.stringify(await q('t.number IN (:...v)', { v: ['A-1', 'B-1'] })) === '["i1","i3"]');
check('T3 $elemMatch on jsonb array', JSON.stringify(await q("EXISTS (SELECT 1 FROM jsonb_array_elements(t.lines) e WHERE e->>'sku' = :s AND (e->>'qty')::numeric >= :n)", { s: 'y', n: 2 })) === '["i3"]');

// T6: undefined in a find where — historically matched ALL rows in TypeORM
let undef;
try { undef = await repo.findOne({ where: { id: undefined } }); } catch (e) { undef = `throws: ${e.message.slice(0, 60)}`; }
check('T6 findOne({ where: { id: undefined } }) does NOT return an arbitrary row', undef === null || String(undef).startsWith('throws'), JSON.stringify(undef)?.slice(0, 80));
let undef2;
try { undef2 = await repo.find({ where: { tenantId: undefined } }); } catch (e) { undef2 = `throws: ${e.message.slice(0, 60)}`; }
check('T6 find({ where: { tenantId: undefined } }) does NOT return every row', !(Array.isArray(undef2) && undef2.length === 3), Array.isArray(undef2) ? `${undef2.length} rows` : undef2);

// T4: RLS per transaction via QueryRunner (non-owner role)
await d2.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN DROP OWNED BY app_user; DROP ROLE app_user; END IF; END $$;`);
await d2.query(`CREATE ROLE app_user LOGIN PASSWORD 'app' NOBYPASSRLS`);
await d2.query(`CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text LANGUAGE plpgsql STABLE AS $f$ DECLARE v text := current_setting('app.tenant_id', true); BEGIN IF v IS NULL OR v = '' THEN RAISE EXCEPTION 'tenant context missing' USING ERRCODE = 'insufficient_privilege'; END IF; RETURN v; END $f$`);
await d2.query(`ALTER TABLE invoices_typeorm ENABLE ROW LEVEL SECURITY; ALTER TABLE invoices_typeorm FORCE ROW LEVEL SECURITY; DROP POLICY IF EXISTS ti ON invoices_typeorm; CREATE POLICY ti ON invoices_typeorm USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant())); GRANT SELECT, INSERT, UPDATE, DELETE ON invoices_typeorm TO app_user`);
const app = await new DataSource({ type: 'postgres', url: 'postgres://app_user:app@127.0.0.1:5434/proto', entities: [toSchema(meta({ note: { kind: 'string', optional: true }, dueAt: { kind: 'date', optional: true } }))], extra: { max: 1 } }).initialize();
const rlsRows = await app.transaction(async (em) => {
  await em.query(`SELECT set_config('app.tenant_id', $1, true)`, ['t1']);
  return em.getRepository('Invoice').find();
});
check('T4 RLS: tenant t1 sees only its rows', rlsRows.length === 2 && rlsRows.every((r) => r.tenantId === 't1'), String(rlsRows.length));
let rlsErr;
try { await app.getRepository('Invoice').find(); } catch (e) { rlsErr = e; }
check('T4 RLS: no tenant context raises 42501 (QueryFailedError.driverError.code)', rlsErr?.driverError?.code === '42501', rlsErr ? `${rlsErr.constructor.name} ${rlsErr.driverError?.code}` : 'NO ERROR');

// T5: atomic claim with ON CONFLICT … WHERE expired … RETURNING (16 parallel workers, own pool of 20)
const pool = await new DataSource({ type: 'postgres', url: URL, extra: { max: 20 } }).initialize();
await pool.query('DROP TABLE IF EXISTS locks_typeorm; CREATE TABLE locks_typeorm (key text PRIMARY KEY, owner text NOT NULL, expires_at timestamptz NOT NULL)');
let oneWinner = true;
for (let round = 0; round < 10; round++) {
  const winners = (await Promise.all(Array.from({ length: 16 }, (_, i) => pool.query(
    `INSERT INTO locks_typeorm (key, owner, expires_at) VALUES ($1, $2, now() + interval '5 seconds')
     ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at WHERE locks_typeorm.expires_at < now()
     RETURNING owner`, [`k${round}`, `w${i}`])))).filter((r) => r.length && r[0].owner);
  if (winners.length !== 1) oneWinner = false;
}
check('T5 atomic claim: exactly one winner in 10 rounds x 16 workers', oneWinner);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(results.every((r) => r.ok) ? 'ALL PASS' : 'SOME FAILED');
await Promise.all([d2.destroy(), app.destroy(), pool.destroy()]);
