import { Schema } from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';

import { describeSchema } from '../../src/core/common/persistence/model-metadata.registry';
import { compileMysqlUpdate } from '../../src/core/common/persistence/sql/mysql/mysql-update.compiler';
import { UnsupportedQueryError } from '../../src/core/common/persistence/sql/sql-errors';
import { SqlParams } from '../../src/core/common/persistence/sql/sql-naming';

/**
 * The MySQL / MariaDB update compiler in isolation (phase 6): what it refuses. Its answers against real servers,
 * compared with MongoDB's, are in `tests/persistence-parity.e2e-spec.ts`.
 */
const model = describeSchema(
  'MysqlCounter',
  new Schema({ age: Number, meta: Schema.Types.Mixed, profile: { city: String }, tags: [String] }),
);
const compile = (update: Record<string, unknown>) => compileMysqlUpdate('mysql', model, update, new SqlParams());
const PROTOTYPE_KEYS = ['bypassTenantGuard', 'isAdminBypass', 'polluted'];

describe('MySQL update compiler', () => {
  afterEach(() => {
    // A failing case must not leave the process polluted for the next one
    for (const key of PROTOTYPE_KEYS) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  /**
   * @regression   DEV-3848 (db-agnostic phase 6, review) — the skeleton of a nested `$set` / `$inc` was built on plain
   *   objects from the path segments, so `meta.__proto__.bypassTenantGuard.x` wrote into Object.prototype: every
   *   request context inherited a truthy `bypassTenantGuard`, and tenant isolation was off for the whole process.
   * @seen-failing Accept `__proto__`, `constructor` and `prototype` in isPathSegment() of
   *   src/core/common/persistence/sql/sql-naming.ts — registered as mutation `sql-path-accepts-prototype-names` in
   *   tests/regression-mutations.json.
   */
  it.each([
    [{ $set: { 'meta.__proto__.bypassTenantGuard.x': 1 } }],
    [{ $inc: { 'meta.constructor.prototype.isAdminBypass.y': 1 } }],
    [{ $set: { 'meta.prototype.polluted.z': 'x' } }],
  ])('refuses a path through the prototype machinery and leaves Object.prototype alone: %j', (update) => {
    expect(() => compile(update)).toThrow(UnsupportedQueryError);
    for (const key of PROTOTYPE_KEYS) {
      expect(({} as Record<string, unknown>)[key], key).toBeUndefined();
    }
  });

  /**
   * @regression   DEV-3848 (db-agnostic phase 6, review) — an operator the compiler does not know would be dropped:
   *   `$max` answered success and changed nothing but the update time.
   * @seen-failing Skip an unknown operator instead of throwing in compile() of
   *   src/core/common/persistence/sql/mysql/mysql-update.compiler.ts — registered as mutation
   *   `mysql-unknown-update-operator-dropped` in tests/regression-mutations.json.
   */
  it('refuses an operator it cannot express instead of dropping it', () => {
    for (const update of [{ $max: { age: 50 } }, { $rename: { age: 'years' } }, { $mul: { age: 2 } }]) {
      expect(() => compile(update), JSON.stringify(update)).toThrow(UnsupportedQueryError);
    }
  });

  /**
   * @regression   DEV-3848 (db-agnostic phase 6, review) — every column gets ONE expression that reads the stored value,
   *   so a second operator on the same path would silently win over the first (`$inc` lost to `$set`), where MongoDB
   *   answers "would create a conflict".
   * @seen-failing Make claim() accept a path that is already written in
   *   src/core/common/persistence/sql/mysql/mysql-update.compiler.ts — registered as mutation
   *   `mysql-update-conflict-accepted` in tests/regression-mutations.json.
   */
  it('refuses two operators on one path, or on a path and a path inside it, as MongoDB does', () => {
    for (const update of [
      { $inc: { age: 5 }, $set: { age: 1 } },
      { $set: { profile: { city: 'x' } }, $unset: { 'profile.city': 1 } },
      { $set: { 'meta.a': 1 }, $unset: { 'meta.a.b': 1 } },
      { $pull: { tags: 'x' }, $push: { tags: 'y' } },
    ]) {
      expect(() => compile(update), JSON.stringify(update)).toThrow(/would create a conflict/);
    }
  });

  it('writes independent paths of one column into one expression', () => {
    const assignments = compile({ $inc: { 'meta.count': 1 }, $set: { 'meta.label': 'x', 'meta.nested.deep': 2 } });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatch(/^`meta` = JSON_SET\(JSON_MERGE_PATCH\(/);
  });
});
