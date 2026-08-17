/**
 * "This object has already been checked" — as a MARKER the framework sets, not a property data carries.
 *
 * WHY THIS FILE EXISTS: three places short-circuit on
 * `_objectAlreadyCheckedForRestrictions` — `checkRestricted()` returns the object untouched,
 * `CheckSecurityInterceptor` skips `securityCheck()`, and `ResponseModelInterceptor` skips the
 * Plain→Model conversion. The opt-out is legitimate: without it one response is checked three times.
 *
 * What was NOT legitimate is how it was recognised. Every read was a plain truthy test on a
 * well-known property name, and nothing in `src/` ever wrote it — so the only way the flag could ever
 * be set was from outside the framework. Which means a document carrying
 * `_objectAlreadyCheckedForRestrictions: true` — from a raw write, a `strict: false` schema, a
 * restored export — disabled EVERY field-level access check for that object, silently, on the output
 * path where a skipped check produces no error at all. That is a data-shaped authorization switch,
 * and data must never be able to flip one.
 *
 * The fix keeps the feature and removes the forgeability: the marker's VALUE is a module-private
 * symbol. JSON, BSON and any client payload can produce the key, and none of them can produce that
 * value. The property is also non-enumerable, so it never reaches a response body and cannot re-enter
 * through a round trip as exactly the data shape above.
 *
 * DELIBERATELY IMPORT-FREE, so `restricted.decorator` (whose position on zero import cycles is a
 * defended property) and both interceptors can read it without a new import edge between them.
 * See `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)".
 */

/**
 * The property name, unchanged since it is part of the observable API — a project may look for it.
 * Only the way it is RECOGNISED changed.
 */
export const RESTRICTIONS_CHECKED_KEY = '_objectAlreadyCheckedForRestrictions';

/**
 * The only value that counts as "checked". Module-private on purpose: it is not exported, so nothing
 * outside this file — and nothing that arrives as data — can reproduce it.
 */
const MARKER = Symbol('restrictionsChecked');

/**
 * Mark an object as already checked, so the framework's own layers do not check it again.
 *
 * Non-enumerable and non-writable: it must not appear in `Object.keys()`, in `JSON.stringify()` or in
 * a Mongoose write. `configurable: true` so the same object can be re-marked without throwing.
 *
 * Returns the object, so it can be used inline.
 */
export function markRestrictionsChecked<T>(data: T): T {
  if (!data || typeof data !== 'object') {
    return data;
  }
  Object.defineProperty(data, RESTRICTIONS_CHECKED_KEY, {
    configurable: true,
    enumerable: false,
    value: MARKER,
    writable: false,
  });
  return data;
}

/**
 * Has the framework marked this object as checked?
 *
 * The identity comparison is the whole point — `!!data[KEY]` would be satisfied by any truthy value,
 * including one that came out of the database.
 */
export function hasRestrictionsCheckedMarker(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as Record<string, unknown>)[RESTRICTIONS_CHECKED_KEY] === MARKER;
}

/**
 * Does this object carry the KEY without the marker — i.e. an unforgeable-looking value that is not
 * actually the marker?
 *
 * Used to warn once rather than to decide anything. Two callers can produce this state, and they want
 * opposite answers: a project that used to set the flag by hand (`obj[KEY] = true`) has silently lost
 * its opt-out and should hear about it, while a document that carries the field from a raw write has
 * silently LOST a bypass it should never have had. A warning names the situation without guessing
 * which one it is; treating it as "checked" is what this file exists to stop.
 */
export function hasUnrecognizedRestrictionsFlag(data: unknown): boolean {
  return (
    !!data &&
    typeof data === 'object' &&
    RESTRICTIONS_CHECKED_KEY in (data as object) &&
    (data as Record<string, unknown>)[RESTRICTIONS_CHECKED_KEY] !== MARKER
  );
}
