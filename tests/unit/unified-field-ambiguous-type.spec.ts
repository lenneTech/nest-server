/**
 * `@UnifiedField` warns when a field's type comes only from `design:type` and that says `Object` (or an enum object).
 *
 * The SWC loader of the dev start writes `Object` for a union with null, a type alias or `boolean | null` where the tsc
 * build writes `Number` / `String` / `Boolean`. Without `type`, `isAny` or `enum` the dev API then validates such a
 * field as a nested object, silently. The warning names the field once. For an enum SWC writes the enum object, which
 * the decorator reads as String / Number like tsc — so the Mongoose path type matches the build as well.
 *
 * The decorator is applied by hand with the metadata a compiler would have written, so the case does not depend on
 * which compiler runs the test.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { UnifiedField } from '../../src/core/common/decorators/unified-field.decorator';
import { Schema, SchemaFactory } from '../../src/core/common/persistence/mongo/mongoose-compat';

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

describe('@UnifiedField — ambiguous metadata type', () => {
  let warn: MockInstance;

  const warnedAbout = (hint: string) =>
    warn.mock.calls.filter(([message]) => String(message).includes(`"${hint}" has no explicit type`)).length;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  /**
   * @regression   12.8.6 — a field whose dev-start metadata was only Object validated as a nested object in the dev
   *   API (`max: 5` refused) while the tsc build accepted it, and nothing said so.
   * @seen-failing Drop the warnIfAmbiguousMetadataType() call in UnifiedField()
   *   (src/core/common/decorators/unified-field.decorator.ts) — registered as mutation
   *   `unified-field-ambiguous-type-silent` in tests/regression-mutations.json.
   */
  it('warns once for a field typed only as Object', () => {
    const objectField = decorate(Object);
    expect(warnedAbout(objectField)).toBe(1);
    expect(warn.mock.calls.at(-1)?.[0]).toContain('type: () => Number');
  });

  it('stays quiet when the type is decided: a primitive, type, isAny or enum', () => {
    const quiet = [
      decorate(Number),
      decorate(String),
      decorate(Object, { type: () => Object }),
      decorate(Object, { isAny: true }),
      decorate({ A: 'a' }, { enum: { A: 'a' } }),
      // The enum object SWC writes is read as String / Number like tsc, so there is nothing to warn about
      decorate({ A: 'a', B: 'b' }),
      decorate({ 1: 'High', 2: 'Low', High: 1, Low: 2 }),
      decorate(undefined),
    ];
    for (const hint of quiet) {
      expect(warnedAbout(hint), hint).toBe(0);
    }
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
