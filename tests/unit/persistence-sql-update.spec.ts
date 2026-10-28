import { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { describeSchema } from '../../src/core/common/persistence/model-metadata.registry';
import { compilePostgresUpdate } from '../../src/core/common/persistence/sql/postgres/postgres-update.compiler';
import { SqlParams } from '../../src/core/common/persistence/sql/sql-naming';

/**
 * The Postgres update compiler in isolation. Its answers against a real database, compared with MongoDB's, are in
 * `tests/persistence-parity.e2e-spec.ts`.
 */
const FIELDS = Array.from({ length: 12 }, (_value, index) => `f${index}`);
const model = describeSchema(
  'Counter',
  new Schema({
    meta: Schema.Types.Mixed,
    stats: Object.fromEntries(FIELDS.map((name) => [name, Number])),
    tags: [String],
  }),
);

function compile(update: Record<string, unknown>): string {
  return compilePostgresUpdate(model, update, new SqlParams()).join(', ');
}

describe('Postgres update compiler', () => {
  /**
   * @regression   DEV-3829 (db-agnostic phase 1, review) — the running expression of a column was inlined at every
   *   reference, so each nested path level and each chained `$inc` / `$addToSet` doubled the statement: 20 `$inc`
   *   on one embedded object built 2^20 copies, a request any client could send.
   * @seen-failing Inline `expr` at every reference in UpdateCompiler.bind() in
   *   src/core/common/persistence/sql/postgres/postgres-update.compiler.ts — registered as mutation
   *   `sql-update-expression-doubles` in tests/regression-mutations.json.
   */
  it('grows linearly with chained operators on one column', () => {
    const one = compile({ $inc: { 'stats.f0': 1 } }).length;
    const all = compile({ $inc: Object.fromEntries(FIELDS.map((name) => [`stats.${name}`, 1])) }).length;
    expect(all).toBeLessThan(one * FIELDS.length * 2);
  });

  it('grows linearly with the depth of a path', () => {
    const shallow = compile({ $set: { 'meta.a.b': 1 } }).length;
    const deep = compile({ $set: { 'meta.a.b.c.d.e.f.g.h.i.j.k.l': 1 } }).length;
    expect(deep).toBeLessThan(shallow * 12);
  });
});
