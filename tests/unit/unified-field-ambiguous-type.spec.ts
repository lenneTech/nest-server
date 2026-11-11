/**
 * `@UnifiedField` refuses a field whose type would come only from a `design:type` that says `Object` (12.9.0; 12.8.7
 * warned), and reads the enum object SWC writes as String / Number.
 *
 * The SWC loader of the dev start writes `Object` for a union with null, a type alias or `boolean | null` where the tsc
 * build writes `Number` / `String` / `Boolean`. Without `type`, `isAny` or `enum` the dev API validated such a field as a
 * nested object, silently. For an enum SWC writes the enum object, which the decorator reads as String / Number like
 * tsc — so the Mongoose path type matches the build as well.
 *
 * Most cases apply the decorator by hand with the metadata a compiler would have written, so they do not depend on
 * which compiler runs the test. One case runs the real dev-start path: `node -r <the framework's SWC loader>` on a
 * fixture, in a child process (the loader patches `require.extensions`, which must not happen inside a vitest worker).
 */
import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { UnifiedField } from '../../src/core/common/decorators/unified-field.decorator';
import { Schema, SchemaFactory } from '../../src/core/common/persistence/mongo/mongoose-compat';

const ROOT = process.cwd();
const LOADER = join(ROOT, 'src/core/modules/migrate/helpers/ts-compiler.js');
const FIXTURES = join(ROOT, 'tests/unit/fixtures/unified-field');

let counter = 0;

/** A fresh class whose `field` carries the given design:type, decorated with `options`. */
function decorate(metadataType: unknown, options: Record<string, unknown> = {}): string {
  const name = `AmbiguousTypeProbe${++counter}`;
  const Klass = { [name]: class {} }[name];
  if (metadataType !== undefined) {
    Reflect.defineMetadata('design:type', metadataType, Klass.prototype, 'field');
  }
  UnifiedField({ isOptional: true, ...options })(Klass.prototype, 'field');
  return `${name}.field`;
}

/** The fixture run the way a project's dev start runs its sources. */
function devStart(fixture: string) {
  const result = spawnSync(process.execPath, ['-r', LOADER, join(FIXTURES, fixture)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
    timeout: 60_000,
  });
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe('@UnifiedField — field type only "Object" in the metadata', () => {
  /**
   * @regression   12.9.0 (DEV-4182) — a field whose dev-start metadata was only Object validated as a nested object in
   *   the dev API (`max: 5` refused) while the tsc build accepted it; 12.8.7 only warned, which a start-up log hides.
   * @seen-failing Drop the assertExplicitTypeForObjectMetadata() call in UnifiedField()
   *   (src/core/common/decorators/unified-field.decorator.ts) — registered as mutation
   *   `unified-field-ambiguous-type-silent` in tests/regression-mutations.json.
   */
  it('refuses a field typed only as Object, naming the field and the declarations that fix it', () => {
    let message = '';
    try {
      decorate(Object);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`"AmbiguousTypeProbe${counter}.field" has no explicit type`);
    expect(message).toContain('type: () => Number');
    expect(message).toContain('type: () => Object for a free-form object, or isAny: true');
    expect(message).toContain('nest-check-unified-field-types --fix');
    // A mixed enum: SWC writes its object, tsc writes Object — neither names a type the field could be validated as
    expect(() => decorate({ 0: 'Low', High: 'high', Low: 0 })).toThrow(/has no explicit type/);
  });

  it('accepts a field whose type is decided: a primitive, type, isAny or enum', () => {
    const accepted = [
      () => decorate(Number),
      () => decorate(String),
      () => decorate(Boolean),
      () => decorate(Date),
      () => decorate(Object, { type: () => Object }),
      () => decorate(Object, { type: () => Number }),
      () => decorate(Object, { isAny: true }),
      () => decorate({ A: 'a' }, { enum: { A: 'a' } }),
      // The enum object SWC writes is read as String / Number like tsc
      () => decorate({ A: 'a', B: 'b' }),
      () => decorate({ 1: 'High', 2: 'Low', High: 1, Low: 2 }),
      // No metadata at all (no emitDecoratorMetadata): nothing to read as Object
      () => decorate(undefined),
    ];
    for (const apply of accepted) {
      expect(apply).not.toThrow();
    }
  });

  it('refuses `max?: null | number` without type under the SWC dev start, and loads and accepts max: 5 with it', () => {
    const undeclared = devStart('undeclared-union.ts');
    expect(undeclared.code).not.toBe(0);
    expect(undeclared.stderr).toContain('[@UnifiedField] "RequestInput.max" has no explicit type');
    expect(undeclared.stdout).not.toContain('loaded');

    const declared = devStart('declared-union.ts');
    expect(declared.stderr).toBe('');
    expect(declared.code).toBe(0);
    expect(JSON.parse(declared.stdout.trim())).toEqual({ errors: 0, loaded: true });
  });

  /**
   * @regression   12.8.7 (found in review) — SWC writes the enum OBJECT as design:type; read as is, it became the Mongoose
   *   path type of `@UnifiedField({ enum: Status, mongoose: true })`, and SchemaFactory refused the schema
   *   ("'active' is not a valid type") — the dev start crashed while the tsc build booted.
   * @seen-failing Read design:type without designTypeOf() in UnifiedField()
   *   (src/core/common/decorators/unified-field.decorator.ts) — registered as mutation `unified-field-enum-object-kept`
   *   in tests/regression-mutations.json.
   */
  it('builds the Mongoose schema of an enum field from the enum object SWC writes, as String / Number', () => {
    const name = `EnumSchemaProbe${++counter}`;
    const Klass = { [name]: class {} }[name];
    const status = { Active: 'active', Inactive: 'inactive' };
    const level = { 1: 'Low', 2: 'High', High: 2, Low: 1 };
    Reflect.defineMetadata('design:type', status, Klass.prototype, 'status');
    Reflect.defineMetadata('design:type', level, Klass.prototype, 'level');
    UnifiedField({ enum: status, isOptional: true, mongoose: true })(Klass.prototype, 'status');
    UnifiedField({ enum: level, isOptional: true, mongoose: true })(Klass.prototype, 'level');
    Schema()(Klass);

    const schema = SchemaFactory.createForClass(Klass);
    expect(schema.path('status').instance).toBe('String');
    expect(schema.path('level').instance).toBe('Number');
  });
});
