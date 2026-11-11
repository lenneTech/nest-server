/**
 * Child fixture for `../../unified-field-ambiguous-type.spec.ts`, run as `node -r <loader> <this file>` — the dev start
 * of a project. `max?: null | number` WITH `type`: loads, and the validation accepts `max: 5`.
 *
 * Not a `*.spec.ts`, so neither vitest runner picks it up as a suite.
 */
import 'reflect-metadata';

import { validate } from 'class-validator';

import { UnifiedField } from '../../../../src/core/common/decorators/unified-field.decorator.js';

class RequestInput {
  @UnifiedField({ description: 'Upper limit', isOptional: true, type: () => Number })
  max?: null | number;
}

// A rejection fails the child with a non-zero exit, which the spec asserts against
void validate(Object.assign(new RequestInput(), { max: 5 })).then((errors) => {
  console.log(JSON.stringify({ errors: errors.length, loaded: true }));
});
