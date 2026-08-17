import 'reflect-metadata';
import { ObjectType } from '@nestjs/graphql';
import { describe, expect, it } from 'vitest';

import { checkRestricted, Restricted } from '../../src/core/common/decorators/restricted.decorator';
import { UnifiedField } from '../../src/core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { prepareOutput } from '../../src/core/common/helpers/service.helper';
import { CoreModel } from '../../src/core/common/models/core-model.model';

/**
 * Field-level access control on NESTED data — per level, or only at the top?
 *
 * Written thesis-first. `checkRestricted()` visibly recurses, so "does it recurse" was never the
 * question. The question is whether the recursion can still SEE the restrictions one level down: the
 * metadata lookup reads from the VALUE's class, and a nested value that arrives as a plain object
 * has `Object` as its constructor — which carries no `@Restricted` metadata at all, so every nested
 * restriction evaluated to "no restrictions" and the field was returned in full.
 *
 * That is not a contrived shape, it is the normal one: `CoreModel.map()` is a shallow
 * `Object.assign`, `prepareOutput()` maps only the target model, and `ResponseModelInterceptor`
 * maps only the top-level item. So an EMBEDDED SUBDOCUMENT read out of MongoDB — a patient's
 * insurance block, an array of findings — is a plain object by the time the check walks it, while an
 * instance of the same class is filtered correctly. Both halves are asserted below, because "it
 * works" was true for one of them.
 *
 * @regression   11.35.0 — nested `@Restricted` silently did nothing on embedded subdocuments.
 * @seen-failing Make `checkRestricted()` in
 *   `src/core/common/decorators/restricted.decorator.ts` derive `metadataOwner` from
 *   `data.constructor` alone again (drop the `declaredType` fallback) — registered as mutation
 *   `nested-restricted-ignores-declared-type` in `tests/regression-mutations.json`.
 */

/** Nested type with its own field-level restriction — an embedded subdocument, not a ref. */
@ObjectType()
class Insurance {
  @UnifiedField({ description: 'Policy number', roles: RoleEnum.ADMIN, type: () => String })
  policyNumber?: string = undefined;

  @UnifiedField({ description: 'Provider', type: () => String })
  provider?: string = undefined;
}

/** Two levels down, to prove the declared type is resolved at every level and not just the first. */
@ObjectType()
class Billing {
  @UnifiedField({ description: 'Insurance', type: () => Insurance })
  insurance?: Insurance = undefined;

  @UnifiedField({ description: 'Cost centre', type: () => String })
  costCentre?: string = undefined;
}

/** Restricted at CLASS level — nobody below ADMIN may see it at all. */
@ObjectType()
@Restricted(RoleEnum.ADMIN)
class InternalNote {
  @UnifiedField({ description: 'Text', type: () => String })
  text?: string = undefined;
}

/** A nested type the registry knows nothing about: declared with a bare decorator, no type hint. */
@ObjectType()
class Undeclared {
  @UnifiedField({ description: 'Secret', roles: RoleEnum.ADMIN, type: () => String })
  secret?: string = undefined;
}

@ObjectType()
class Patient extends CoreModel {
  @UnifiedField({ description: 'SSN', roles: RoleEnum.ADMIN, type: () => String })
  ssn?: string = undefined;

  @UnifiedField({ description: 'Name', type: () => String })
  name?: string = undefined;

  @UnifiedField({ description: 'Insurance', type: () => Insurance })
  insurance?: Insurance = undefined;

  @UnifiedField({ description: 'Insurances', isArray: true, type: () => Insurance })
  insurances?: Insurance[] = undefined;

  @UnifiedField({ description: 'Billing', type: () => Billing })
  billing?: Billing = undefined;

  @UnifiedField({ description: 'Note', type: () => InternalNote })
  note?: InternalNote = undefined;

  /** No `type` hint, so nothing records what this holds — the documented limit. */
  @UnifiedField({ description: 'Free-form payload', isAny: true })
  extra?: any = undefined;
}

/** A signed-in, non-admin user — the requester every case below runs as. */
const plainUser = {
  hasRole: (roles: string[]) => roles.includes('patient'),
  id: 'user-1',
  roles: ['patient'],
};

const adminUser = {
  hasRole: (roles: string[]) => roles.includes(RoleEnum.ADMIN),
  id: 'admin-1',
  roles: [RoleEnum.ADMIN],
};

/** Restrictions are stripped in place, so every case needs its own graph. */
function plainPayload(): Record<string, any> {
  return {
    billing: { costCentre: 'CC-1', insurance: { policyNumber: 'POLICY-DEEP', provider: 'DEEP' } },
    extra: { secret: 'FREE-FORM' },
    id: 'p1',
    insurance: { policyNumber: 'POLICY-SECRET', provider: 'ACME' },
    insurances: [
      { policyNumber: 'POLICY-1', provider: 'ACME' },
      { policyNumber: 'POLICY-2', provider: 'OTHER' },
    ],
    name: 'Patient One',
    note: { text: 'internal' },
    ssn: 'SSN-SECRET',
  };
}

describe('@Restricted on nested data', () => {
  it('strips a restricted field on the TOP level', () => {
    const result = checkRestricted(Patient.map(plainPayload()), plainUser, { throwError: false });

    expect(result.name).toBe('Patient One');
    expect(result.ssn).toBeUndefined();
  });

  it('strips a restricted field on a nested value that IS an instance of its class', () => {
    const patient = Patient.map(plainPayload()) as Patient;
    patient.insurance = Object.assign(new Insurance(), plainPayload().insurance);

    const result = checkRestricted(patient, plainUser, { throwError: false });

    expect(result.insurance.provider).toBe('ACME');
    expect(result.insurance.policyNumber).toBeUndefined();
  });

  /** THESIS: a nested EMBEDDED subdocument is checked per level, not skipped. */
  it('strips a restricted field on a nested PLAIN object (embedded subdocument)', () => {
    const result = checkRestricted(Patient.map(plainPayload()), plainUser, { throwError: false });

    expect(result.insurance.provider).toBe('ACME');
    expect(result.insurance.policyNumber).toBeUndefined();
  });

  /** THESIS: the same holds for EVERY item of an array of embedded subdocuments, not just the first. */
  it('strips a restricted field on every item of a nested array', () => {
    const result = checkRestricted(Patient.map(plainPayload()), plainUser, { throwError: false });

    expect(result.insurances.map((entry: any) => entry.provider)).toEqual(['ACME', 'OTHER']);
    expect(result.insurances[0].policyNumber).toBeUndefined();
    expect(result.insurances[1].policyNumber).toBeUndefined();
  });

  /** THESIS: resolution continues at every level, not only one below the model. */
  it('strips a restricted field TWO levels down', () => {
    const result = checkRestricted(Patient.map(plainPayload()), plainUser, { throwError: false });

    expect(result.billing.costCentre).toBe('CC-1');
    expect(result.billing.insurance.provider).toBe('DEEP');
    expect(result.billing.insurance.policyNumber).toBeUndefined();
  });

  /**
   * THESIS (partly REFUTED, and the refutation is the point): a CLASS-level restriction on a nested
   * type was expected to remove the whole nested value. It does not — and that is not a nesting
   * defect but the documented `checkObjectItself: false` default, under which a class restriction is
   * MERGED into every property's restrictions instead of acting as a standalone gate. So the data is
   * gone and an empty container remains.
   *
   * Asserted as the real contract rather than the assumed one, and asserted for an INSTANCE too, so
   * the two cannot drift: if nesting ever became stricter than instances, that difference would be
   * the bug.
   */
  it('strips the contents of a nested value whose CLASS is restricted, leaving an empty container', () => {
    const result = checkRestricted(Patient.map(plainPayload()), plainUser, { throwError: false });

    expect(result.note.text, 'no data may survive a class-level restriction').toBeUndefined();
    expect(Object.keys(result.note)).toHaveLength(0);

    const asInstance = checkRestricted(
      Object.assign(Patient.map(plainPayload()), { note: Object.assign(new InternalNote(), { text: 'internal' }) }),
      plainUser,
      { throwError: false },
    );
    expect(asInstance.note.text).toBeUndefined();
  });

  /**
   * THESIS: the same holds through the pipeline a service actually runs — `prepareOutput()` with a
   * `targetModel`, then the rights check. This is the shape every CrudService response has.
   */
  it('strips nested restricted fields through prepareOutput + check', async () => {
    const prepared = await prepareOutput(plainPayload(), { targetModel: Patient });
    const result = checkRestricted(prepared, plainUser, { throwError: false });

    expect(result.ssn).toBeUndefined();
    expect(result.insurance.policyNumber).toBeUndefined();
    expect(result.insurances[0].policyNumber).toBeUndefined();
    expect(result.billing.insurance.policyNumber).toBeUndefined();
  });

  it('leaves a nested restricted field intact for a caller who may see it', () => {
    const result = checkRestricted(Patient.map(plainPayload()), adminUser, { throwError: false });

    expect(result.ssn).toBe('SSN-SECRET');
    expect(result.insurance.policyNumber).toBe('POLICY-SECRET');
    expect(result.insurances[1].policyNumber).toBe('POLICY-2');
    expect(result.note.text).toBe('internal');
  });

  /**
   * THE DOCUMENTED LIMIT, asserted so it is a stated property rather than a surprise.
   *
   * A property with no declared type records nothing, so nothing can say what its value was meant
   * to be — and a nested value there is just as legitimately free-form JSON, a `Map` or a scalar.
   * Failing closed on those would strip vastly more than it protects, so an unknown nested type
   * stays unchecked. Declare nested types with `@UnifiedField({ type: () => X })` to have them
   * enforced.
   */
  it('does NOT reach into a nested value whose type was never declared', () => {
    const payload = plainPayload();
    payload.extra = Object.assign({}, plainPayload().extra) as Record<string, any>;
    const result = checkRestricted(Patient.map(payload), plainUser, { throwError: false });

    expect(result.extra.secret, 'undeclared nested types stay unchecked — see Undeclared').toBe('FREE-FORM');
    // …and the same class IS enforced once it is an instance, which is what makes the gap a
    // declaration gap rather than a metadata gap.
    const instance = checkRestricted(Object.assign(new Undeclared(), { secret: 'X' }), plainUser, {
      throwError: false,
    });
    expect(instance.secret).toBeUndefined();
  });
});
