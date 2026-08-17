/**
 * Which CLASS a model property declares — the only record of that fact at runtime.
 *
 * DELIBERATELY IMPORT-FREE. Two files need this map and they sit on opposite ends of an import
 * edge: `unified-field.decorator` writes it (and already imports `restricted.decorator` for
 * `@Restricted`), while `restricted.decorator` reads it. Keeping the map here means the reader adds
 * no import back into the writer — `restricted.decorator` drives field-level access control and its
 * position on zero import cycles is a defended property, not an accident.
 * See `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)".
 *
 * WHY IT EXISTS AT ALL: TypeScript types are erased, and `design:type` degrades to `Array` for a
 * typed array and is only emitted for decorated properties. So a nested value read out of MongoDB —
 * an embedded subdocument, or an array of them — arrives as a PLAIN object whose constructor is
 * `Object`. Nothing on the value itself can say what it was declared as, which means nothing can
 * find the `@Restricted` / validation metadata that belongs to it. This map is what closes that gap.
 *
 * Filled by `@UnifiedField()` for every non-primitive property. A property declared without
 * `@UnifiedField` is absent, and consumers must treat "absent" as "unknown", never as "no
 * restrictions" — see `checkRestricted()` for how that is handled.
 */

/** Key: `${className}.${propertyName}` — value: the declared (element) type. */
export const nestedTypeRegistry = new Map<string, any>();

/**
 * The class a property of `ownerClass` declares, or `undefined` when nothing recorded it.
 *
 * Walks the PROTOTYPE CHAIN of the class, because `@UnifiedField()` registers under the class it was
 * applied to — a property inherited from a base model is recorded under the BASE class name, and a
 * lookup that only tried the leaf would miss it.
 */
export function resolveNestedType(ownerClass: unknown, propertyKey: string): any {
  let current: any = ownerClass;
  while (current && current !== Object && typeof current === 'function') {
    const found = nestedTypeRegistry.get(`${current.name}.${propertyKey}`);
    if (found) {
      return found;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
