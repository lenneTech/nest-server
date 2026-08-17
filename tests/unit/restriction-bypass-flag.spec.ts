import 'reflect-metadata';
import { ObjectType } from '@nestjs/graphql';
import { describe, expect, it, vi } from 'vitest';

import { checkRestricted } from '../../src/core/common/decorators/restricted.decorator';
import { UnifiedField } from '../../src/core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { CoreModel } from '../../src/core/common/models/core-model.model';

/**
 * `_objectAlreadyCheckedForRestrictions` — a bypass the framework READS but never SETS.
 *
 * Three places short-circuit on it: `checkRestricted()` returns the object untouched,
 * `CheckSecurityInterceptor` skips `securityCheck()`, and `ResponseModelInterceptor` skips the
 * Plain→Model conversion. Nothing in `src/` ever writes it — it exists so a caller that has ALREADY
 * run the checks can say so and avoid paying for them twice.
 *
 * That makes it a **data-shaped authorization switch**, and those deserve a test. The question is not
 * whether the framework misuses it (it does not use it at all), but what happens when the flag arrives
 * from somewhere the framework does not control:
 *
 *  - from a CLIENT, on the input path — `MapAndValidatePipe` whitelists `@UnifiedField` properties, so
 *    an unknown key is stripped. Asserted below, because that is the guarantee the whole shape rests
 *    on.
 *  - from the DATABASE, on the output path — a document that somehow carries the field (a raw write, a
 *    `strict: false` schema, a restored export) would skip every field-level check for that object.
 *
 * The second case is why this file exists. It is NOT closed by making the flag unreadable — the
 * opt-out is a real feature with a real caller shape — but it must be an EXPLICIT, non-enumerable
 * marker rather than any truthy property with the right name, so that data can never impersonate it.
 * `markRestrictionsChecked()` is that marker, and the assertions below pin both halves: the marker
 * works, and a plain data property with the same name does not.
 *
 * @regression   11.35.0 — a plain `_objectAlreadyCheckedForRestrictions: true` property carried on a
 *   persisted document disabled every `@Restricted` check for that object.
 * @seen-failing Make `hasRestrictionsCheckedMarker()` in
 *   `src/core/common/decorators/restricted.decorator.ts` read the property directly again
 *   (`return !!data?.[RESTRICTIONS_CHECKED]`) — registered as mutation
 *   `restriction-bypass-flag-trusts-data` in `tests/regression-mutations.json`. The migration WARNING
 *   has its own mutation, `restriction-flag-migration-warning-silent`: a tightening nobody is told
 *   about leaves a project debugging stripped fields with nothing pointing at the cause.
 */

@ObjectType()
class Secretive extends CoreModel {
  @UnifiedField({ description: 'Secret', roles: RoleEnum.ADMIN, type: () => String })
  secret?: string = undefined;

  @UnifiedField({ description: 'Public', type: () => String })
  label?: string = undefined;
}

const plainUser = {
  hasRole: (roles: string[]) => roles.includes('patient'),
  id: 'user-1',
  roles: ['patient'],
};

describe('_objectAlreadyCheckedForRestrictions', () => {
  it('strips the restricted field for a caller who may not see it (control)', () => {
    const result = checkRestricted(Secretive.map({ label: 'ok', secret: 'SECRET' }), plainUser, {
      throwError: false,
    });

    expect(result.label).toBe('ok');
    expect(result.secret).toBeUndefined();
  });

  /**
   * THESIS: a DATA property named `_objectAlreadyCheckedForRestrictions` cannot disable the checks.
   *
   * This is the shape a document carries after a raw write, a `strict: false` schema or a restored
   * export — none of which the framework mediates, and all of which end up on the OUTPUT path where
   * `throwError` is false and a skipped check is silent.
   */
  it('does not let a plain data property disable the checks — and says so once', async () => {
    // The WARNING is asserted HERE, in the first case that touches the legacy shape, because it fires
    // once per PROCESS: a per-object warning on the hottest path of the response pipeline would bury
    // the one line that matters. Splitting it into its own case would make the assertion depend on
    // test ordering — the trap this repo has already hit with the excludeSchemas warning.
    //
    // It matters because tightening the recognition is safe but NOT silent: a project that set the flag
    // by hand loses its opt-out, and the fields it set the flag to PRESERVE are now stripped. Three
    // customer projects do exactly that across twelve call sites, and none can adopt
    // `markRestrictionsChecked()` before the framework update lands. So the message they will see the
    // first time it happens is the whole migration signal.
    const { Logger } = await import('@nestjs/common');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      const payload: Record<string, any> = {
        _objectAlreadyCheckedForRestrictions: true,
        label: 'ok',
        secret: 'SECRET',
      };
      const result = checkRestricted(Object.assign(Secretive.map(payload), payload), plainUser, {
        throwError: false,
      });

      expect(result.secret, 'a data property must not switch off field-level access control').toBeUndefined();

      const messages = warn.mock.calls.map(call => String(call[0])).join('\n');
      expect(messages, 'the message must name the replacement').toContain('markRestrictionsChecked');
      expect(messages).toContain('_objectAlreadyCheckedForRestrictions');

      // Once per process: a second object must not add a line.
      const before = warn.mock.calls.length;
      checkRestricted(Object.assign(Secretive.map(payload), payload), plainUser, { throwError: false });
      expect(warn.mock.calls.length, 'warned again for a second object').toBe(before);
    } finally {
      warn.mockRestore();
    }
  });

  /** The same, one level down — a nested subdocument is exactly where such a field survives unnoticed. */
  it('does not let a plain data property disable the checks on a NESTED value', () => {
    const result = checkRestricted(
      {
        nested: Object.assign(Secretive.map({ label: 'ok', secret: 'SECRET' }), {
          _objectAlreadyCheckedForRestrictions: true,
        }),
      },
      plainUser,
      { throwError: false },
    );

    expect(result.nested.secret).toBeUndefined();
  });

  /**
   * THESIS: the opt-out still works for its intended caller — code that has already run the checks and
   * says so through the framework's own marker.
   *
   * Removing the feature would be the wrong fix: the interceptor chain relies on it to avoid checking
   * one response three times.
   */
  it('honours the explicit marker set through the framework helper', async () => {
    const { markRestrictionsChecked } = await import('../../src/core/common/decorators/restricted.decorator');
    const model = markRestrictionsChecked(Secretive.map({ label: 'ok', secret: 'SECRET' }));

    const result = checkRestricted(model, plainUser, { throwError: false });

    expect(result.secret, 'an explicitly marked object is passed through untouched').toBe('SECRET');
  });

  /** The marker must not travel through JSON — otherwise it re-enters as exactly the data shape above. */
  it('keeps the marker off the serialized response', async () => {
    const { markRestrictionsChecked } = await import('../../src/core/common/decorators/restricted.decorator');
    const model = markRestrictionsChecked(Secretive.map({ label: 'ok', secret: 'SECRET' }));

    expect(Object.keys(model)).not.toContain('_objectAlreadyCheckedForRestrictions');
    expect(JSON.stringify(model)).not.toContain('_objectAlreadyCheckedForRestrictions');
  });
});
