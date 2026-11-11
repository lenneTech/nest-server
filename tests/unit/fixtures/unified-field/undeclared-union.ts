/**
 * Child fixture for `../../unified-field-ambiguous-type.spec.ts`, run as `node -r <loader> <this file>` — the dev start
 * of a project. `max?: null | number` WITHOUT `type`: the SWC loader writes `Object` as its design:type, so the field
 * must refuse to load (12.9.0) instead of being validated as a nested object.
 *
 * Not a `*.spec.ts`, so neither vitest runner picks it up as a suite.
 */
import 'reflect-metadata';

import { UnifiedField } from '../../../../src/core/common/decorators/unified-field.decorator.js';

class RequestInput {
  @UnifiedField({ description: 'Upper limit', isOptional: true })
  max?: null | number;
}

console.log(JSON.stringify({ loaded: RequestInput.name }));
