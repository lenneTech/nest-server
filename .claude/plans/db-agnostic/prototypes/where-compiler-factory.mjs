// Where compiler from prototype 03, parameterised over a tagged-template `sql` implementation
// (Kysely and Drizzle expose the same shape: template, ref/identifier, raw, join, literal).
export function makeCompiler(sql) {
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

function compileWhere(where) {
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


  return { compileWhere, UnsupportedQueryError };
}
