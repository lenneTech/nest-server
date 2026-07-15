import { ForbiddenException } from '@nestjs/common';

import { Restricted, checkRestricted } from '../../src/core/common/decorators/restricted.decorator';
import { ProcessType } from '../../src/core/common/enums/process-type.enum';
import { RoleEnum } from '../../src/core/common/enums/role.enum';

/**
 * Ownership roles (S_SELF, S_CREATOR) must be decided from the PERSISTED object, never from the
 * request payload.
 *
 * The bug this file guards against: `checkRestricted()` read the ownership claim off `data` — and on
 * the input path `data` IS the caller-supplied DTO. An authenticated attacker could unlock an
 * owner-restricted field on someone ELSE's record just by asserting ownership in the body:
 *
 *   PATCH /users/<victim>  { "id": "<attacker>", "createdBy": "<attacker>", "iban": "DE...attacker" }
 *
 * The service applies the input to the target it was called with (`<victim>`), not to the ids in the
 * body — so the guard passed while the write landed on the victim. Three reads were affected:
 * S_SELF (`equalIds(data, user)`), S_CREATOR (`data.createdBy`), and the `isCreatorOfParent` flag,
 * which propagated the forged trust down into nested objects.
 *
 * `check()` (input.helper.ts) always read both from `config.dbObject` and got this right.
 *
 * Every case below is asserted in BOTH directions: the attacker must be rejected AND the legitimate
 * owner must still get through — a fix that simply denies everything would be no fix at all.
 *
 * The rejection is a `ForbiddenException` (403), not a 401: the attacker IS authenticated (they have
 * an id) and merely lacks the right — see accessDeniedException. 401 is reserved for anonymous
 * requesters, which never reach these ownership branches end-to-end (the guards stop them first).
 */

/** Stands in for a consumer model: `iban` is owner-only, `note` is creator-only. */
class Account {
  createdBy?: string = undefined;

  id: string = undefined;

  @Restricted(RoleEnum.S_SELF)
  iban?: string = undefined;

  @Restricted(RoleEnum.S_CREATOR)
  note?: string = undefined;
}

/** A nested object without its own `createdBy` — reaches S_CREATOR via `allowCreatorOfParent`. */
class Settings {
  @Restricted(RoleEnum.S_CREATOR)
  secret?: string = undefined;
}

class AccountWithSettings {
  createdBy?: string = undefined;

  id: string = undefined;

  settings?: Settings = undefined;
}

/**
 * The shape consumers actually ship: a class-level role plus a field-level ownership role.
 * `mergeRoles` (default: true) OR-merges them, so S_USER alone already grants the field — the
 * ownership check never gates. Every real usage in our customer projects looks like this.
 */
@Restricted(RoleEnum.S_USER)
class SharedInput {
  @Restricted(RoleEnum.S_SELF)
  colour?: string = undefined;
}

const ATTACKER = { hasRole: () => false, id: 'attacker-1' };

/** The victim's record, as it exists in the database. */
function victimRecord(): Account {
  return Object.assign(new Account(), {
    createdBy: 'victim-1',
    iban: 'DE00 VICTIM',
    id: 'victim-1',
    note: 'victim note',
  });
}

/** The attacker's own record, as it exists in the database. */
function ownRecord(): Account {
  return Object.assign(new Account(), {
    createdBy: 'attacker-1',
    iban: 'DE00 OWN',
    id: 'attacker-1',
    note: 'own note',
  });
}

const INPUT = { processType: ProcessType.INPUT, throwError: true } as const;
const OUTPUT = { processType: ProcessType.OUTPUT, throwError: false } as const;

describe('checkRestricted() — ownership is read from the persisted object', () => {
  describe('INPUT: S_SELF', () => {
    it('rejects a forged id in the payload (attack)', () => {
      const forged = Object.assign(new Account(), { iban: 'DE00 ATTACKER', id: 'attacker-1' });

      expect(() => checkRestricted(forged, ATTACKER, { ...INPUT, dbObject: victimRecord() })).toThrow(
        ForbiddenException,
      );
    });

    it('still lets the owner set the field on their own record (legitimate)', () => {
      const input = Object.assign(new Account(), { iban: 'DE00 NEW' });

      const result = checkRestricted(input, ATTACKER, { ...INPUT, dbObject: ownRecord() });

      expect(result.iban).toEqual('DE00 NEW');
    });

    it('does not need an id in the DTO — the persisted object decides', () => {
      // The old implementation only ever passed when the DTO carried an id, which is why S_SELF was
      // ALSO broken for honest callers: a normal update DTO has none.
      const input = Object.assign(new Account(), { iban: 'DE00 NEW' });

      expect(input.id).toBeUndefined();
      expect(checkRestricted(input, ATTACKER, { ...INPUT, dbObject: ownRecord() }).iban).toEqual('DE00 NEW');
    });

    it('denies the field when no persisted object exists (create)', () => {
      const input = Object.assign(new Account(), { iban: 'DE00 NEW', id: 'attacker-1' });

      expect(() => checkRestricted(input, ATTACKER, { ...INPUT })).toThrow(ForbiddenException);
    });
  });

  describe('INPUT: S_CREATOR', () => {
    it('rejects a forged createdBy in the payload (attack)', () => {
      const forged = Object.assign(new Account(), { createdBy: 'attacker-1', note: 'hijacked' });

      expect(() => checkRestricted(forged, ATTACKER, { ...INPUT, dbObject: victimRecord() })).toThrow(
        ForbiddenException,
      );
    });

    it('still lets the creator set the field on the record they created (legitimate)', () => {
      const input = Object.assign(new Account(), { note: 'my note' });

      const result = checkRestricted(input, ATTACKER, { ...INPUT, dbObject: ownRecord() });

      expect(result.note).toEqual('my note');
    });

    it('denies the field when no persisted object exists (create)', () => {
      const input = Object.assign(new Account(), { createdBy: 'attacker-1', note: 'x' });

      expect(() => checkRestricted(input, ATTACKER, { ...INPUT })).toThrow(ForbiddenException);
    });
  });

  describe('INPUT: nested objects (isCreatorOfParent)', () => {
    it('does not let a forged parent ownership claim unlock a nested field (attack)', () => {
      // The nested Settings has no createdBy of its own, so it relies on the parent's ownership.
      // A forged id/createdBy on the parent DTO must not grant that trust.
      const forged = Object.assign(new AccountWithSettings(), {
        createdBy: 'attacker-1',
        id: 'attacker-1',
        settings: Object.assign(new Settings(), { secret: 'hijacked' }),
      });

      expect(() =>
        checkRestricted(forged, ATTACKER, {
          ...INPUT,
          allowCreatorOfParent: true,
          dbObject: victimRecord(), // the write really targets the victim
        }),
      ).toThrow(ForbiddenException);
    });

    it('still lets the parent’s creator write the nested field (legitimate)', () => {
      const input = Object.assign(new AccountWithSettings(), {
        settings: Object.assign(new Settings(), { secret: 'mine' }),
      });

      const result = checkRestricted(input, ATTACKER, {
        ...INPUT,
        allowCreatorOfParent: true,
        dbObject: ownRecord(),
      });

      expect(result.settings.secret).toEqual('mine');
    });
  });

  describe('INPUT: a class-level restriction is OR-merged and must keep working', () => {
    // mergeRoles defaults to true and the roles are OR-ed, so a class-level @Restricted WIDENS the
    // field-level one rather than narrowing it. Every real consumer usage of S_SELF/S_CREATOR sits on
    // a class that also carries S_USER or ADMIN, which is why they pass without a dbObject at all.
    // Pinned here so the ownership fix provably does not tighten those paths.
    it('lets any authenticated user through when the class adds S_USER — even without a dbObject', () => {
      const input = Object.assign(new SharedInput(), { colour: 'red' });

      const result = checkRestricted(input, ATTACKER, { ...INPUT });

      expect(result.colour).toEqual('red');
    });

    it('and still lets them through on an update targeting a foreign record', () => {
      const input = Object.assign(new SharedInput(), { colour: 'red' });

      const result = checkRestricted(input, ATTACKER, { ...INPUT, dbObject: victimRecord() });

      // Not a hole this fix opens: S_USER alone already grants the field. Consumers who mean
      // "only the owner" must NOT put a broader role on the class.
      expect(result.colour).toEqual('red');
    });
  });

  describe('OUTPUT: semantics must not change (data IS the persisted object here)', () => {
    it('keeps owner- and creator-restricted fields on the requester’s own record', () => {
      const result = checkRestricted(ownRecord(), ATTACKER, { ...OUTPUT });

      expect(result.iban).toEqual('DE00 OWN');
      expect(result.note).toEqual('own note');
    });

    it('strips owner- and creator-restricted fields from a foreign record', () => {
      const result = checkRestricted(victimRecord(), ATTACKER, { ...OUTPUT });

      expect(result.iban).toBeUndefined();
      expect(result.note).toBeUndefined();
      expect(result.id).toEqual('victim-1'); // unrestricted fields survive
    });

    it('decides per item in a list, not once for the whole response', () => {
      const result = checkRestricted([ownRecord(), victimRecord()], ATTACKER, { ...OUTPUT });

      expect(result[0].iban).toEqual('DE00 OWN');
      expect(result[1].iban).toBeUndefined();
    });

    it('is not overridden by a dbObject that happens to be set', () => {
      // On output the per-item object must win — a dbObject must never widen the response.
      const result = checkRestricted(victimRecord(), ATTACKER, { ...OUTPUT, dbObject: ownRecord() });

      expect(result.iban).toBeUndefined();
      expect(result.note).toBeUndefined();
    });

    it('resolves a nested creator-restricted field via the parent (allowCreatorOfParent)', () => {
      const own = Object.assign(new AccountWithSettings(), {
        createdBy: 'attacker-1',
        id: 'attacker-1',
        settings: Object.assign(new Settings(), { secret: 'mine' }),
      });
      const foreign = Object.assign(new AccountWithSettings(), {
        createdBy: 'victim-1',
        id: 'victim-1',
        settings: Object.assign(new Settings(), { secret: 'not yours' }),
      });

      expect(checkRestricted(own, ATTACKER, { ...OUTPUT, allowCreatorOfParent: true }).settings.secret).toEqual('mine');
      expect(
        checkRestricted(foreign, ATTACKER, { ...OUTPUT, allowCreatorOfParent: true }).settings.secret,
      ).toBeUndefined();
    });
  });
});
