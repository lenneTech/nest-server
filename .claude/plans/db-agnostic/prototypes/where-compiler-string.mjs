// Engine-neutral where compiler (extracted from 09): SQL text with named :pN placeholders + params, Postgres dialect, table alias "t".
const meta = {
  fields: {
    id: { type: 'id', column: 'id' }, name: { type: 'string' }, age: { type: 'number' }, active: { type: 'boolean' },
    createdAt: { type: 'date', column: 'created_at' }, score: { type: 'number' }, tags: { type: 'array', items: 'string' },
    address: { type: 'object', nested: { city: 'string', zip: 'string', floor: 'number' } }, roles: { type: 'array', items: 'string' },
    contacts: { type: 'array', items: 'object', nested: { kind: 'string', value: 'string', primary: 'boolean' } },
  },
};
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
class UnsupportedQueryError extends Error {}

export function compile(where) {
  const params = {};
  let n = 0;
  const p = (v) => { const k = `p${n++}`; params[k] = v instanceof Date ? v.toISOString() : v; return `:${k}`; };
  const pj = (v) => `${p(JSON.stringify(v instanceof Date ? v.toISOString() : v))}::jsonb`;
  const col = (name) => `"t"."${meta.fields[name].column ?? name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}"`;
  const isOp = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp) && Object.keys(v).some((k) => k.startsWith('$'));

  const resolve = (path) => {
    const [head, ...rest] = path.split('.');
    const field = meta.fields[head];
    if (!field) throw new UnsupportedQueryError(`unknown field "${head}"`);
    for (const s of rest) if (!SEGMENT.test(s)) throw new UnsupportedQueryError(`invalid path segment "${s}"`);
    if (!rest.length) return { kind: field.type === 'array' ? 'array' : 'column', field, expr: col(head) };
    if (field.type !== 'object' || !field.nested?.[rest[0]]) throw new UnsupportedQueryError(`unknown sub-field "${path}"`);
    return { kind: 'json', field, expr: `(${col(head)} #> '{${rest.join(',')}}')` }; // segments validated above
  };
  const eq = (t, v) => {
    if (v instanceof RegExp) return regex(t, v.source, v.flags);
    if (t.kind === 'column') return v === null ? `${t.expr} IS NULL` : `${t.expr} = ${p(v)}`;
    if (t.kind === 'json') return v === null ? `(${t.expr} IS NULL OR ${t.expr} = 'null'::jsonb)` : `${t.expr} = ${pj(v)}`;
    if (Array.isArray(v)) return `${t.expr} = ${pj(v)}`;
    return v === null ? `(${t.expr} IS NULL)` : `${t.expr} @> ${pj([v])}`;
  };
  const cmp = (t, op, v) => {
    const o = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op];
    if (t.kind === 'column') return `${t.expr} ${o} ${p(v)}`;
    const ty = typeof v === 'number' ? 'number' : 'string';
    if (t.kind === 'json') return `(jsonb_typeof(${t.expr}) = '${ty}' AND ${t.expr} ${o} ${pj(v)})`;
    return `EXISTS (SELECT 1 FROM jsonb_array_elements(${t.expr}) e WHERE jsonb_typeof(e) = '${ty}' AND e ${o} ${pj(v)})`;
  };
  const regex = (t, src, flags = '') => {
    const o = flags.includes('i') ? '~*' : '~';
    if (t.kind === 'column') return `${t.expr} ${o} ${p(src)}`;
    if (t.kind === 'json') return `(jsonb_typeof(${t.expr}) = 'string' AND (${t.expr} #>> '{}') ${o} ${p(src)})`;
    return `EXISTS (SELECT 1 FROM jsonb_array_elements_text(${t.expr}) e WHERE e ${o} ${p(src)})`;
  };
  const inList = (t, vals) => (vals.length ? `(${vals.map((v) => eq(t, v)).join(' OR ')})` : 'FALSE');
  const field = (path, cond) => {
    const t = resolve(path);
    if (!isOp(cond)) return eq(t, cond);
    const parts = [];
    for (const [op, v] of Object.entries(cond)) {
      switch (op) {
        case '$eq': parts.push(eq(t, v)); break;
        case '$ne': parts.push(`NOT COALESCE(${eq(t, v)}, FALSE)`); break;
        case '$gt': case '$gte': case '$lt': case '$lte': parts.push(cmp(t, op, v)); break;
        case '$in': parts.push(inList(t, v)); break;
        case '$nin': parts.push(`NOT COALESCE(${inList(t, v)}, FALSE)`); break;
        case '$exists': parts.push(`(${t.expr} IS ${v ? 'NOT ' : ''}NULL)`); break;
        case '$regex': parts.push(regex(t, v instanceof RegExp ? v.source : v, cond.$options ?? (v instanceof RegExp ? v.flags : ''))); break;
        case '$options': break;
        case '$size': parts.push(`jsonb_array_length(${t.expr}) = ${p(v)}`); break;
        case '$all': parts.push(`${t.expr} @> ${pj(v)}`); break;
        case '$elemMatch': {
          const inner = Object.entries(v).map(([k, x]) => {
            if (!t.field.nested?.[k] || !SEGMENT.test(k)) throw new UnsupportedQueryError(`unknown element field "${k}"`);
            const et = { kind: 'json', expr: `(e -> '${k}')` };
            return isOp(x) ? Object.entries(x).map(([o, y]) => (o === '$eq' ? eq(et, y) : cmp(et, o, y))).join(' AND ') : eq(et, x);
          });
          parts.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(${t.expr}) e WHERE ${inner.join(' AND ')})`);
          break;
        }
        case '$not': parts.push(`NOT COALESCE(${field(path, v)}, FALSE)`); break;
        default: throw new UnsupportedQueryError(`operator ${op} is not supported on SQL`);
      }
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
  };
  const top = (w) => {
    const parts = [];
    for (const [k, v] of Object.entries(w ?? {})) {
      if (k === '$and') parts.push(`(${v.map(top).join(' AND ')})`);
      else if (k === '$or') parts.push(`(${v.map(top).join(' OR ')})`);
      else if (k === '$nor') parts.push(`NOT COALESCE((${v.map(top).join(' OR ')}), FALSE)`);
      else if (k.startsWith('$')) throw new UnsupportedQueryError(`top-level ${k} is not supported on SQL`);
      else parts.push(field(k === '_id' ? 'id' : k, v));
    }
    return parts.length ? parts.join(' AND ') : 'TRUE';
  };
  return { text: top(where), params };
}
