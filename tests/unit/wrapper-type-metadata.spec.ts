import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

import type { WrapperType } from '../../src/core/common/types/wrapper.type';

/**
 * `WrapperType<T>` is the remedy the migration guide prescribes for decorated declarations on an import cycle under
 * ESM (12.0.0 §17). It only works because a type alias is not a value: the emitted `design:type` metadata must be
 * `Object`, never the class — reading the class is exactly what throws in the temporal dead zone. If someone turned the
 * alias into a class or a value, the remedy would silently stop working.
 */
const Field = (): PropertyDecorator => () => undefined;

class Target {}

class Holder {
  @Field() direct?: Target;
  @Field() wrapped?: WrapperType<Target>;
}

describe('WrapperType<T> and decorator metadata', () => {
  it('keeps the class out of design:type, so nothing is read at load time', () => {
    expect(Reflect.getMetadata('design:type', Holder.prototype, 'direct')).toBe(Target);
    expect(Reflect.getMetadata('design:type', Holder.prototype, 'wrapped')).toBe(Object);
  });
});
