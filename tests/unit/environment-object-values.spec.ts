import { describe, expect, it } from 'vitest';

import { getEnvironmentObject } from '../../src/core/common/helpers/config.helper';

/**
 * `getEnvironmentObject()` — how `NSC__…` variables become configuration. Deployments set the configuration through
 * them without code (Docker, TurboOps), so a value read the wrong way switches a feature on or off unseen.
 */
function read(env: Record<string, string>): Record<string, any> {
  return getEnvironmentObject({ processEnv: env });
}

describe('getEnvironmentObject: values of NSC__ variables', () => {
  /**
   * @regression   12.11.0 — an empty value became `0`: `NSC__X__ENABLED=` (how a deploy tool often leaves a variable
   *   "unset") read as `0`, which every `enabled !== false` check takes as on, so an emergency access could not be
   *   closed; an empty role became `"0"`.
   * @seen-failing Drop the empty-value check in getEnvironmentObject() (src/core/common/helpers/config.helper.ts) —
   *   registered as mutation `env-empty-value-becomes-zero` in tests/regression-mutations.json.
   */
  it('leaves out an empty value, and the objects of its path', () => {
    expect(read({ NSC__ACCESS__ENABLED: '', NSC__ACCESS__ROLE: '   ' })).toEqual({});
    // A path object would switch a feature on by its presence alone (`redis: {}` enables Redis)
    expect(read({ NSC__REDIS__HOST: '' })).toEqual({});
    expect(read({ NSC__REDIS__HOST: '', NSC__REDIS__PORT: '6380' })).toEqual({ redis: { port: 6380 } });
  });

  /**
   * @regression   12.11.0 — only exactly `true` / `false` became booleans: `FALSE`, `False` and ` false ` stayed text, and
   *   text counts as on in every `enabled !== false` check — `NSC__X__ENABLED=FALSE` switched the feature ON.
   * @seen-failing Compare the untrimmed, case-sensitive value again in prepareEnvironmentValue()
   *   (src/core/common/helpers/config.helper.ts) — registered as mutation `env-false-case-sensitive` in
   *   tests/regression-mutations.json.
   */
  it('reads true and false in any case and with surrounding spaces', () => {
    expect(read({ NSC__A__X: 'FALSE', NSC__A__Y: ' false ', NSC__A__Z: 'True' })).toEqual({
      a: { x: false, y: false, z: true },
    });
  });

  /**
   * @regression   12.11.0 — an `enabled` switch took any text and treated it as on: `ENABLED=off`, `=no` and `=0` left the
   *   feature switched on.
   * @seen-failing Accept any other value for `enabled` again in prepareEnvironmentValue()
   *   (src/core/common/helpers/config.helper.ts) — registered as mutation `env-enabled-text-accepted` in
   *   tests/regression-mutations.json.
   */
  it('takes only true, false, 1 or 0 for a key named enabled and refuses anything else', () => {
    expect(read({ NSC__A__ENABLED: '0', NSC__B__ENABLED: '1', NSC__C__ENABLED: ' TRUE ' })).toEqual({
      a: { enabled: false },
      b: { enabled: true },
      c: { enabled: true },
    });
    expect(() => read({ NSC__ACCESS__ENABLED: 'off' })).toThrow(/NSC__ACCESS__ENABLED="off" is not a switch value/);
    expect(() => read({ NSC__ACCESS__ENABLED: 'no' })).toThrow(/write true or false/);
  });

  it('keeps numbers and other text as before', () => {
    expect(
      read({
        NSC__A__COUNT: '42',
        NSC__A__NAME: 'off',
        NSC__A__ROLE: 'admin',
        NSC__A__ZERO: '0',
      }),
    ).toEqual({ a: { count: 42, name: 'off', role: 'admin', zero: 0 } });
  });
});
