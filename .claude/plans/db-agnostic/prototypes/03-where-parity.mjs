// A2: the Mongo-operator SUBSET as neutral query language. Compile it to SQL (Kysely `sql` fragments,
// parameterised, every path validated against model metadata) and compare results on identical data
// with a real MongoDB.
import { Kysely, PostgresDialect, sql } from 'kysely';
import { MongoClient } from 'mongodb';
import pg from 'pg';

// ---------- model metadata (what @UnifiedField would record) ----------
const meta = {
  table: 'person',
  fields: {
    id: { type: 'id', column: 'id' },
    name: { type: 'string' },
    age: { type: 'number' },
    active: { type: 'boolean' },
    createdAt: { type: 'date', column: 'created_at' },
    score: { type: 'number' },
    tags: { type: 'array', items: 'string' }, // jsonb array
    address: { type: 'object', nested: { city: 'string', zip: 'string', floor: 'number' } }, // jsonb object
    roles: { type: 'array', items: 'string' },
    contacts: { type: 'array', items: 'object', nested: { kind: 'string', value: 'string', primary: 'boolean' } },
  },
};
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
class UnsupportedQueryError extends Error {}

const col = (name) => sql.ref(meta.fields[name].column ?? name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
const jsonPath = (segments) => sql.lit(`{${segments.join(',')}}`);

function resolve(path) {
  const [head, ...rest] = path.split('.');
  const field = meta.fields[head];
  if (!field) throw new UnsupportedQueryError(`unknown field "${head}"`);
  for (const s of rest) if (!PATH_SEGMENT.test(s)) throw new UnsupportedQueryError(`invalid path segment "${s}"`);
  if (!rest.length) return { kind: field.type === 'array' ? 'array' : 'column', field, expr: col(head) };
  if (field.type !== 'object') throw new UnsupportedQueryError(`"${head}" has no sub-fields`);
  const subType = field.nested?.[rest[0]];
  if (!subType) throw new UnsupportedQueryError(`unknown sub-field "${path}"`);
  return { kind: 'json', field, subType, expr: sql`(${col(head)} #> ${jsonPath(rest)})` };
}

const isOperatorObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp) && Object.keys(v).some((k) => k.startsWith('$'));
const toJsonb = (v) => sql`${JSON.stringify(v instanceof Date ? v.toISOString() : v)}::jsonb`;

function cmp(target, op, value) {
  const sqlOp = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op];
  if (target.kind === 'column') return sql`${target.expr} ${sql.raw(sqlOp)} ${value}`;
  if (target.kind === 'json') {
    // Mongo compares only within the same BSON type bracket: mirror it with jsonb_typeof.
    const t = typeof value === 'number' ? 'number' : typeof value === 'string' ? 'string' : null;
    if (!t) throw new UnsupportedQueryError(`${op} on a JSON path needs a number or string`);
    return sql`(jsonb_typeof(${target.expr}) = ${t} AND ${target.expr} ${sql.raw(sqlOp)} ${toJsonb(value)})`;
  }
  // array: any element matches (Mongo semantics)
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${target.expr}) e WHERE jsonb_typeof(e) = ${typeof value === 'number' ? 'number' : 'string'} AND e ${sql.raw(sqlOp)} ${toJsonb(value)})`;
}

function eq(target, value) {
  if (value instanceof RegExp) return regex(target, value.source, value.flags);
  if (target.kind === 'column') return value === null ? sql`${target.expr} IS NULL` : sql`${target.expr} = ${value}`;
  if (target.kind === 'json') return value === null ? sql`(${target.expr} IS NULL OR ${target.expr} = 'null'::jsonb)` : sql`${target.expr} = ${toJsonb(value)}`;
  // array: exact array OR contains the element
  if (Array.isArray(value)) return sql`${target.expr} = ${toJsonb(value)}`;
  if (value === null) return sql`(${target.expr} IS NULL)`;
  return sql`${target.expr} @> ${toJsonb([value])}`;
}

function regex(target, source, flags = '') {
  const op = flags.includes('i') ? '~*' : '~';
  if (target.kind === 'column') return sql`${target.expr} ${sql.raw(op)} ${source}`;
  if (target.kind === 'json') return sql`(jsonb_typeof(${target.expr}) = 'string' AND (${target.expr} #>> '{}') ${sql.raw(op)} ${source})`;
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${target.expr}) e WHERE e ${sql.raw(op)} ${source})`;
}

function inList(target, values) {
  const parts = values.map((v) => eq(target, v));
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`FALSE`;
}

function fieldCondition(path, cond) {
  const target = resolve(path);
  if (!isOperatorObject(cond)) return eq(target, cond);
  const parts = [];
  for (const [op, value] of Object.entries(cond)) {
    switch (op) {
      case '$eq': parts.push(eq(target, value)); break;
      case '$ne': parts.push(sql`NOT COALESCE(${eq(target, value)}, FALSE)`); break;
      case '$gt': case '$gte': case '$lt': case '$lte': parts.push(cmp(target, op, value)); break;
      case '$in': parts.push(inList(target, value)); break;
      case '$nin': parts.push(sql`NOT COALESCE(${inList(target, value)}, FALSE)`); break;
      case '$exists':
        // DIFFERENT-BY-DESIGN on columns: SQL has no "absent" distinct from NULL.
        parts.push(target.kind === 'json'
          ? sql`(${target.expr} IS ${sql.raw(value ? 'NOT ' : '')}NULL)`
          : sql`(${target.expr} IS ${sql.raw(value ? 'NOT ' : '')}NULL)`);
        break;
      case '$regex': parts.push(regex(target, value instanceof RegExp ? value.source : value, cond.$options ?? (value instanceof RegExp ? value.flags : ''))); break;
      case '$options': break;
      case '$size':
        if (target.kind !== 'array') throw new UnsupportedQueryError('$size needs an array');
        parts.push(sql`jsonb_array_length(${target.expr}) = ${value}`); break;
      case '$all':
        if (target.kind !== 'array') throw new UnsupportedQueryError('$all needs an array');
        parts.push(sql`${target.expr} @> ${toJsonb(value)}`); break;
      case '$elemMatch': {
        if (target.kind !== 'array' || target.field.items !== 'object') throw new UnsupportedQueryError('$elemMatch needs an array of objects');
        const inner = Object.entries(value).map(([k, v]) => {
          if (!target.field.nested[k]) throw new UnsupportedQueryError(`unknown element field "${k}"`);
          const t = { kind: 'json', expr: sql`(e -> ${k})` };
          return isOperatorObject(v) ? sql.join(Object.entries(v).map(([o, x]) => (o === '$eq' ? eq(t, x) : cmp(t, o, x))), sql` AND `) : eq(t, v);
        });
        parts.push(sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${target.expr}) e WHERE ${sql.join(inner, sql` AND `)})`);
        break;
      }
      case '$not': parts.push(sql`NOT COALESCE(${fieldCondition(path, value)}, FALSE)`); break;
      default: throw new UnsupportedQueryError(`operator ${op} is not supported on SQL`);
    }
  }
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` AND `)})`;
}

export function compileWhere(where) {
  const parts = [];
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === '$and') parts.push(sql`(${sql.join(value.map(compileWhere), sql` AND `)})`);
    else if (key === '$or') parts.push(sql`(${sql.join(value.map(compileWhere), sql` OR `)})`);
    else if (key === '$nor') parts.push(sql`NOT COALESCE((${sql.join(value.map(compileWhere), sql` OR `)}), FALSE)`);
    else if (key.startsWith('$')) throw new UnsupportedQueryError(`top-level ${key} is not supported on SQL`);
    else parts.push(fieldCondition(key === '_id' ? 'id' : key, value));
  }
  return parts.length ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

// ---------- data, identical in both stores ----------
const d = (s) => new Date(s);
const people = [
  { id: 'p1', name: 'Anna', age: 31, active: true, createdAt: d('2026-01-01'), score: 9.5, tags: ['a', 'b'], roles: ['admin'], address: { city: 'Berlin', zip: '10115', floor: 3 }, contacts: [{ kind: 'mail', value: 'a@test.com', primary: true }] },
  { id: 'p2', name: 'Bernd', age: 45, active: false, createdAt: d('2026-02-01'), score: null, tags: ['b'], roles: [], address: { city: 'Köln', zip: '50667' }, contacts: [] },
  { id: 'p3', name: 'carla', age: 22, active: true, createdAt: d('2026-03-01'), tags: [], roles: ['editor'], address: { city: 'berlin', floor: 0 }, contacts: [{ kind: 'phone', value: '123', primary: false }, { kind: 'mail', value: 'c@test.com', primary: false }] },
  { id: 'p4', name: 'Dora', age: null, active: true, createdAt: d('2026-04-01'), score: 3, tags: ['c', 'a'], roles: ['admin', 'editor'] },
  { id: 'p5', name: 'Emil', active: false, createdAt: d('2026-05-01'), score: 7, tags: ['a'], roles: ['viewer'], address: { city: 'Hamburg', zip: '20095', floor: 12 } },
  { id: 'p6', name: 'Frida', age: 60, active: true, createdAt: d('2026-06-01'), score: 1, tags: ['d'], roles: [], address: null },
];

const mongo = await MongoClient.connect('mongodb://127.0.0.1:27017');
const mcoll = mongo.db('nest-server-proto-parity').collection('person');
await mcoll.deleteMany({});
await mcoll.insertMany(people.map(({ id, ...rest }) => ({ _id: id, ...Object.fromEntries(Object.entries(rest)) })));

const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: 'postgres://proto_owner:proto@127.0.0.1:5434/proto', max: 4 }) }) });
await sql.raw(`DROP TABLE IF EXISTS person; CREATE TABLE person (id text PRIMARY KEY, name text, age double precision, active boolean, created_at timestamptz, score double precision, tags jsonb, roles jsonb, address jsonb, contacts jsonb)`).execute(db);
for (const p of people) {
  await db.insertInto('person').values({
    id: p.id, name: p.name, age: p.age ?? null, active: p.active, created_at: p.createdAt, score: p.score ?? null,
    tags: JSON.stringify(p.tags ?? []), roles: JSON.stringify(p.roles ?? []),
    address: p.address === undefined ? null : JSON.stringify(p.address), contacts: p.contacts === undefined ? null : JSON.stringify(p.contacts),
  }).execute();
}

const cases = [
  { name: 'equality', where: { name: 'Anna' } },
  { name: '$ne includes missing/null like Mongo', where: { age: { $ne: 31 } } },
  { name: 'null matches null AND missing', where: { age: null } },
  { name: '$ne null', where: { age: { $ne: null } } },
  { name: '$gt / $lte range', where: { age: { $gt: 25, $lte: 45 } } },
  { name: '$in scalar', where: { name: { $in: ['Anna', 'Emil', 'X'] } } },
  { name: '$in with null', where: { score: { $in: [null, 7] } } },
  { name: '$nin includes missing', where: { age: { $nin: [31, 45] } } },
  { name: 'boolean', where: { active: false } },
  { name: 'date range', where: { createdAt: { $gte: d('2026-02-01'), $lt: d('2026-05-01') } } },
  { name: 'regex case-insensitive', where: { name: { $regex: '^[ab]', $options: 'i' } } },
  { name: 'RegExp object', where: { name: /a$/ } },
  { name: 'array contains element', where: { tags: 'a' } },
  { name: 'array $in', where: { tags: { $in: ['c', 'd'] } } },
  { name: 'array $all', where: { tags: { $all: ['a', 'b'] } } },
  { name: 'array $size', where: { roles: { $size: 0 } } },
  { name: 'array $nin', where: { roles: { $nin: ['admin'] } } },
  { name: 'array $ne element', where: { roles: { $ne: 'editor' } } },
  { name: 'nested dot path', where: { 'address.city': 'Berlin' } },
  { name: 'nested regex i', where: { 'address.city': { $regex: '^berlin$', $options: 'i' } } },
  { name: 'nested numeric range', where: { 'address.floor': { $gte: 3 } } },
  { name: 'nested $exists', where: { 'address.zip': { $exists: false } } },
  { name: '$elemMatch', where: { contacts: { $elemMatch: { kind: 'mail', primary: false } } } },
  { name: '$or', where: { $or: [{ age: { $lt: 25 } }, { tags: 'd' }] } },
  { name: '$and + $or', where: { active: true, $or: [{ roles: 'admin' }, { 'address.city': 'berlin' }] } },
  { name: '$nor', where: { $nor: [{ active: false }, { tags: 'a' }] } },
  { name: '$not', where: { age: { $not: { $gt: 30 } } } },
  { name: 'id $in', where: { _id: { $in: ['p2', 'p6'] } } },
  { name: '$exists on column (DIFFERENT-BY-DESIGN expected for explicit null)', where: { age: { $exists: true } }, differentByDesign: true },
];

const results = [];
for (const c of cases) {
  const m = (await mcoll.find(c.where).project({ _id: 1 }).toArray()).map((x) => x._id).sort();
  const q = await sql`SELECT id FROM person WHERE ${compileWhere(c.where)}`.execute(db);
  const p = q.rows.map((r) => r.id).sort();
  const same = JSON.stringify(m) === JSON.stringify(p);
  results.push({ ...c, same, m, p });
}
for (const r of results) {
  const tag = r.same ? 'PASS' : r.differentByDesign ? 'DIFF-BY-DESIGN' : 'FAIL';
  console.log(`${tag.padEnd(14)} ${r.name}${r.same ? '' : `  mongo=${JSON.stringify(r.m)} pg=${JSON.stringify(r.p)}`}`);
}
// refusal cases
const refusals = [{ unknownField: 1 }, { 'address.x;drop': 1 }, { $where: 'this.a' }, { name: { $text: 'x' } }, { 'tags.0': 'a' }];
for (const w of refusals) {
  try { compileWhere(w); console.log(`FAIL           refusal not raised for ${JSON.stringify(w)}`); }
  catch (e) { console.log(`PASS           refuses ${JSON.stringify(w)} (${e.message})`); }
}
const fails = results.filter((r) => !r.same && !r.differentByDesign).length;
console.log(fails ? `${fails} PARITY FAILURES` : `PARITY OK (${results.length} cases)`);
await mongo.db('nest-server-proto-parity').dropDatabase();
await mongo.close();
await db.destroy();
