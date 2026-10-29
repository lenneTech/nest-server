import { Schema, Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { Where } from '../../src/core/common/persistence/data-store.interface';
import { describeSchema } from '../../src/core/common/persistence/model-metadata.registry';
import { compilePostgresWhere } from '../../src/core/common/persistence/sql/postgres/postgres-where.compiler';
import { castFilterValue } from '../../src/core/common/persistence/sql/sql-cast';
import { QueryCastError, UnsupportedQueryError } from '../../src/core/common/persistence/sql/sql-errors';
import { columnName, quoteIdentifier, SqlParams } from '../../src/core/common/persistence/sql/sql-naming';

/**
 * The Postgres Where compiler in isolation: what reaches the SQL text and what travels as a parameter. Its answers
 * against a real database, compared with MongoDB's, are in `tests/persistence-sql-where.e2e-spec.ts`.
 */
const model = describeSchema(
  'Account',
  new Schema({
    address: new Schema({ city: String }, { _id: false }),
    age: Number,
    createdAt: Date,
    email: { lowercase: true, trim: true, type: String },
    meta: Schema.Types.Mixed,
    name: String,
    tags: [String],
  }),
);

function compile(where: Where): { params: unknown[]; text: string } {
  const params = new SqlParams();
  const text = compilePostgresWhere(model, where, params, { alias: 't' });
  return { params: params.values, text };
}

const PAYLOAD = "x' OR '1'='1'; DROP TABLE account; --";

describe('Postgres Where compiler', () => {
  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — a filter value written into the SQL text instead of bound as a
   *   parameter turns every filterQuery a client sends into SQL it controls.
   * @seen-failing Write the cast value into the equality on a column in
   *   src/core/common/persistence/sql/postgres/postgres-where.compiler.ts — registered as mutation
   *   `sql-where-inlines-values` in tests/regression-mutations.json.
   */
  it('binds every value as a parameter, never as SQL text', () => {
    for (const where of [
      { name: PAYLOAD },
      { name: { $in: [PAYLOAD, 'b'] } },
      { name: { $ne: PAYLOAD } },
      { name: { $gt: PAYLOAD } },
      { name: { $regex: PAYLOAD } },
      { 'address.city': PAYLOAD },
      { 'meta.note': PAYLOAD },
      { tags: PAYLOAD },
      { $or: [{ name: PAYLOAD }, { email: PAYLOAD }] },
    ] as Where[]) {
      const { params, text } = compile(where);
      expect(text, JSON.stringify(where)).not.toContain('DROP');
      expect(text).not.toContain("'1'='1'");
      expect(JSON.stringify(params)).toContain('DROP TABLE');
    }
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — JSON paths spliced into the SQL text: every SQL library had
   *   advisories on JSON-path injection in 2025–2026; a bound `text[]` cannot be one.
   * @seen-failing Write the path segments into the SQL text in jsonPath() in
   *   src/core/common/persistence/sql/postgres/postgres-where.compiler.ts — registered as mutation
   *   `sql-where-inlines-json-path` in tests/regression-mutations.json.
   */
  it('binds JSON paths as text[] parameters', () => {
    const { params, text } = compile({ 'meta.note': 'x' });
    expect(text).toMatch(/"t"\."meta" #> \$1::text\[\]/);
    expect(text).not.toContain('note');
    expect(params[0]).toEqual(['note']);
  });

  it('maps fields to quoted, aliased columns', () => {
    expect(compile({ createdAt: new Date(0) }).text).toBe('"t"."created_at" = $1');
    expect(compile({ id: new Types.ObjectId('65a1b2c3d4e5f60718293a4b') })).toEqual({
      params: ['65a1b2c3d4e5f60718293a4b'],
      text: '"t"."id" = $1',
    });
    const params = new SqlParams();
    expect(compilePostgresWhere(model, { age: 3 }, params)).toBe('"age" = $1');
  });

  it('uses one array parameter for $in on a column', () => {
    expect(compile({ age: { $in: [1, '2', null] } })).toEqual({
      params: [[1, 2]],
      text: '("t"."age" = ANY($1) OR "t"."age" IS NULL)',
    });
  });

  it('answers an empty filter with TRUE', () => {
    expect(compile({}).text).toBe('TRUE');
    expect(compilePostgresWhere(model, undefined, new SqlParams())).toBe('TRUE');
  });

  /**
   * @regression   DEV-3829 (db-agnostic phase 1) — an operator the compiler does not know was skipped, which
   *   WIDENS the query: a condition meant to narrow a read silently disappears.
   * @seen-failing Skip unknown operators instead of throwing in
   *   src/core/common/persistence/sql/postgres/postgres-where.compiler.ts — registered as mutation
   *   `sql-where-drops-unsupported-operator` in tests/regression-mutations.json.
   */
  it('refuses what it cannot express instead of dropping it', () => {
    for (const where of [
      { unknown: 1 },
      { 'name.first': 'x' },
      { 'address.unknown': 'x' },
      { 'address.city;drop': 'x' },
      { 'meta.0': 'x' },
      { 'meta.$where': 'x' },
      { constructor: 'x' },
      JSON.parse('{"__proto__": "x"}'), // an own key, as a parsed request body carries it
      { $where: 'true' },
      { $expr: { $eq: ['$a', 1] } },
      { name: { $text: 'x' } },
      { name: { $where: 'true' } },
      { name: { $gt: 'a', other: 1 } },
      { name: { $options: 'i' } },
      { name: { $regex: 'a', $options: 'q' } },
      { name: { $eq: /a/ } },
      { name: { $not: 'a' } },
      { name: { $elemMatch: { $gt: 1 } } },
      { age: { $regex: '1' } },
      { age: { $gt: null } },
      { tags: { $all: [{ $elemMatch: { $gt: 'a' } }] } },
      { $or: [] },
      { $and: 'x' },
    ] as Where[]) {
      expect(() => compile(where), JSON.stringify(where)).toThrow(UnsupportedQueryError);
    }
  });

  it('refuses a value Mongoose would refuse to cast', () => {
    for (const where of [
      { age: 'abc' },
      { id: 'abc' },
      { createdAt: 'yesterday' },
      { tags: { $size: -1 } },
    ] as Where[]) {
      expect(() => compile(where), JSON.stringify(where)).toThrow(QueryCastError);
    }
  });

  it('writes regular-expression flags as embedded ARE options', () => {
    const pattern = (flags: string) => compile({ name: { $options: flags, $regex: 'a' } }).params[0];
    expect(pattern('')).toBe('(?p)a');
    expect(pattern('i')).toBe('(?pi)a');
    expect(pattern('m')).toBe('(?n)a');
    expect(pattern('s')).toBe('(?s)a');
    expect(pattern('ms')).toBe('(?w)a');
    expect(pattern('gix')).toBe('(?pix)a');
    expect(compile({ name: /a/imu }).params[0]).toBe('(?ni)a');
  });
});

describe('filter value casting (Mongoose rules)', () => {
  const field = (kind: string, extra: Record<string, unknown> = {}) =>
    ({
      hasDefault: false,
      index: false,
      isArray: false,
      kind,
      lowercase: false,
      name: 'f',
      required: false,
      select: true,
      sparse: false,
      trim: false,
      unique: false,
      ...extra,
    }) as any;

  it.each([
    ['number', '5', 5],
    ['number', '', null],
    ['number', true, 1],
    ['boolean', 'yes', true],
    ['boolean', '0', false],
    ['date', '2026-01-02T03:04:05.000Z', new Date('2026-01-02T03:04:05.000Z')],
    ['date', '300000', new Date(300000)],
    ['date', 1000, new Date(1000)],
    ['id', 'ABCDEFABCDEFABCDEFABCDEF', 'abcdefabcdefabcdefabcdef'],
    ['ref', 'not-an-object-id', 'not-an-object-id'],
    ['ref', { _id: new Types.ObjectId('65a1b2c3d4e5f60718293a4b') }, '65a1b2c3d4e5f60718293a4b'],
    ['string', 42, '42'],
    ['decimal', '1.50', '1.50'],
    ['bigint', 12, '12'],
    ['uuid', 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
  ])('%s: %j → %j', (kind, value, expected) => {
    expect(castFilterValue(field(kind), 'f', value)).toEqual(expected);
  });

  it.each([
    ['number', 'abc'],
    ['boolean', 'maybe'],
    ['date', 'yesterday'],
    ['date', true],
    ['id', 'abc'],
    ['string', { a: 1 }],
    ['bigint', '1.5'],
    ['uuid', 'x'],
  ])('%s refuses %j', (kind, value) => {
    expect(() => castFilterValue(field(kind), 'f', value)).toThrow(QueryCastError);
  });

  it('applies lowercase and trim like Mongoose setters, unless told not to', () => {
    const email = field('string', { lowercase: true, trim: true });
    expect(castFilterValue(email, 'email', '  A@B.de ')).toBe('a@b.de');
    expect(castFilterValue(email, 'email', '  A@B.de ', false)).toBe('  A@B.de ');
  });

  it('never puts the value into the error message', () => {
    try {
      castFilterValue(field('number'), 'age', 'secret-value');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-value');
      expect(error).toMatchObject({ kind: 'Number', path: 'age' });
    }
  });
});

describe('SQL naming', () => {
  it.each([
    ['_id', 'id'],
    ['id', 'id'],
    ['createdAt', 'created_at'],
    ['userID', 'user_id'],
    ['HTMLParser', 'html_parser'],
    ['apiKeyEncrypted', 'api_key_encrypted'],
    ['address2Line', 'address2_line'],
  ])('%s → %s', (field, column) => {
    expect(columnName(field)).toBe(column);
  });

  it('refuses what is not an identifier', () => {
    for (const name of ['a-b', 'a.b', '1a', 'a b', '"a"', '']) {
      expect(() => columnName(name), name).toThrow(UnsupportedQueryError);
      expect(() => quoteIdentifier(name), name).toThrow(UnsupportedQueryError);
    }
    expect(() => quoteIdentifier('a'.repeat(64))).toThrow(UnsupportedQueryError);
    expect(quoteIdentifier('a'.repeat(63))).toBe(`"${'a'.repeat(63)}"`);
  });
});
