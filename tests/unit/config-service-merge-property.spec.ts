/**
 * `ConfigService#mergeProperty(key, value)` must merge `value` under `key`.
 *
 * @regression   12.5.0 — the instance method forwarded `options` in place of `value`, so
 *   `configService.mergeProperty('x', { a: 1 })` merged `undefined` and the call changed nothing.
 * @seen-failing Forward `options` instead of `value` from the instance mergeProperty() in
 *   src/core/common/services/config.service.ts — registered as mutation
 *   `config-service-merge-property-drops-value` in tests/regression-mutations.json.
 */
import { describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';

describe('ConfigService#mergeProperty', () => {
  it('merges the given value under the key', () => {
    ConfigService.setConfig({ env: 'unit', feature: { a: 1 } } as any, { reInit: true });
    const service = new ConfigService();

    service.mergeProperty('feature', { b: 2 });

    expect(ConfigService.configFastButReadOnly.feature).toEqual({ a: 1, b: 2 });
  });
});
