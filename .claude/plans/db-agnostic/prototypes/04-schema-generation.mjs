// A7: metadata -> DDL (+ additive diff for migrations). Variant 1: own generator over Kysely + information_schema.
// Variant 2: MikroORM 7 SchemaGenerator from a programmatic EntitySchema. Same neutral metadata for both.
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

const URL = 'postgres://proto_owner:proto@127.0.0.1:5434/proto';
// neutral field descriptors as @UnifiedField would record them
const v1 = {
  name: 'Invoice',
  table: 'invoices',
  tenantScoped: true,
  fields: {
    id: { kind: 'id' },
    number: { kind: 'string', unique: true },
    total: { kind: 'number' },
    paid: { kind: 'boolean', default: false },
    issuedAt: { kind: 'date', index: true },
    customer: { kind: 'ref', ref: 'Customer' },
    lines: { kind: 'json' }, // declared nested array -> jsonb
    tenantId: { kind: 'string' },
  },
  compoundIndexes: [{ fields: ['tenantId', 'number'], unique: true }],
};
// v2 adds two optional fields and an index (what a later release would do)
const v2 = structuredClone(v1);
v2.fields.note = { kind: 'string', optional: true };
v2.fields.dueAt = { kind: 'date', optional: true, index: true };

const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const colType = (f) => ({ id: 'text', string: 'text', number: 'double precision', boolean: 'boolean', date: 'timestamptz', ref: 'text', json: 'jsonb' })[f.kind];

// ---------- Variant 1: own generator ----------
function createTableSql(m) {
  const cols = Object.entries(m.fields).map(([k, f]) => {
    const parts = [`"${snake(k)}" ${colType(f)}`];
    if (f.kind === 'id') parts.push('PRIMARY KEY');
    else if (!f.optional) parts.push('NOT NULL');
    if (f.default !== undefined) parts.push(`DEFAULT ${JSON.stringify(f.default)}`);
    return parts.join(' ');
  });
  cols.push('"created_at" timestamptz NOT NULL DEFAULT now()', '"updated_at" timestamptz NOT NULL DEFAULT now()');
  return [`CREATE TABLE "${m.table}" (\n  ${cols.join(',\n  ')}\n)`, ...indexSql(m)];
}
function indexSql(m, only) {
  const out = [];
  for (const [k, f] of Object.entries(m.fields)) {
    if (only && !only.has(k)) continue;
    if (f.unique && !m.tenantScoped) out.push(`CREATE UNIQUE INDEX "${m.table}_${snake(k)}_uq" ON "${m.table}" ("${snake(k)}")`);
    else if (f.index || f.kind === 'ref' || (f.unique && m.tenantScoped)) out.push(`CREATE INDEX "${m.table}_${snake(k)}_idx" ON "${m.table}" ("${snake(k)}")`);
  }
  if (!only) for (const ci of m.compoundIndexes ?? []) {
    const cols = ci.fields.map((c) => `"${snake(c)}"`).join(', ');
    out.push(`CREATE ${ci.unique ? 'UNIQUE ' : ''}INDEX "${m.table}_${ci.fields.map(snake).join('_')}_${ci.unique ? 'uq' : 'idx'}" ON "${m.table}" (${cols})`);
  }
  return out;
}
async function diffSql(db, m) {
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${m.table}`.execute(db);
  if (!cols.rows.length) return createTableSql(m);
  const have = new Set(cols.rows.map((r) => r.column_name));
  const added = new Set();
  const stmts = [];
  for (const [k, f] of Object.entries(m.fields)) {
    if (have.has(snake(k))) continue;
    added.add(k);
    // additive only; a NOT NULL column without default on a non-empty table needs a hand-written migration
    if (!f.optional && f.default === undefined) throw new Error(`"${k}" is required without default: write a data migration`);
    stmts.push(`ALTER TABLE "${m.table}" ADD COLUMN "${snake(k)}" ${colType(f)}${f.default !== undefined ? ` NOT NULL DEFAULT ${JSON.stringify(f.default)}` : ''}`);
  }
  stmts.push(...indexSql(m, added));
  return stmts;
}

const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: URL, max: 2 }) }) });
await sql`DROP TABLE IF EXISTS invoices`.execute(db);
const t0 = performance.now();
for (const s of createTableSql(v1)) await sql.raw(s).execute(db);
const up = await diffSql(db, v2);
for (const s of up) await sql.raw(s).execute(db);
const again = await diffSql(db, v2);
console.log(`OWN  create v1: ${createTableSql(v1).length} stmts; diff v1->v2: ${up.length} stmts; diff v2->v2: ${again.length} stmts (${(performance.now() - t0).toFixed(0)} ms)`);
console.log(up.map((s) => `     ${s}`).join('\n'));
let refused;
try { const v3 = structuredClone(v2); v3.fields.mandatory = { kind: 'string' }; await diffSql(db, v3); } catch (e) { refused = e.message; }
console.log(`OWN  required column without default refused: ${refused ? 'yes' : 'NO'}`);

// ---------- Variant 2: MikroORM 7 SchemaGenerator ----------
try {
  const { MikroORM, EntitySchema } = await import('@mikro-orm/postgresql');
  const toSchema = (m) => new EntitySchema({
    name: m.name,
    tableName: `${m.table}_mikro`,
    properties: Object.fromEntries(Object.entries(m.fields).map(([k, f]) => [k, {
      type: { id: 'string', string: 'string', number: 'double', boolean: 'boolean', date: 'Date', ref: 'string', json: 'json' }[f.kind],
      primary: f.kind === 'id' || undefined,
      nullable: !!f.optional || undefined,
      defaultRaw: f.default === undefined ? undefined : String(f.default),
      index: f.index || f.kind === 'ref' || undefined,
    }])),
    indexes: (m.compoundIndexes ?? []).filter((c) => !c.unique).map((c) => ({ properties: c.fields })),
    uniques: (m.compoundIndexes ?? []).filter((c) => c.unique).map((c) => ({ properties: c.fields })),
  });
  const t1 = performance.now();
  await sql`DROP TABLE IF EXISTS invoices_mikro`.execute(db);
  let orm = await MikroORM.init({ entities: [toSchema(v1)], clientUrl: URL, debug: false, allowGlobalContext: true });
  const gen = orm.schema ?? orm.getSchemaGenerator();
  const create = await gen.getCreateSchemaSQL({ wrap: false });
  await (gen.update ?? gen.updateSchema).call(gen);
  await orm.close();
  orm = await MikroORM.init({ entities: [toSchema(v2)], clientUrl: URL, debug: false, allowGlobalContext: true });
  const gen2 = orm.schema ?? orm.getSchemaGenerator();
  const diff = await gen2.getUpdateSchemaSQL({ wrap: false });
  await orm.close();
  console.log(`MIKRO create v1: ${create.split(';').filter((x) => x.trim()).length} stmts; diff v1->v2:\n${diff.split('\n').filter(Boolean).map((l) => `     ${l}`).join('\n')}\n     (${(performance.now() - t1).toFixed(0)} ms)`);
} catch (e) {
  console.log(`MIKRO failed: ${e.message.split('\n')[0]}`);
}
await db.destroy();
