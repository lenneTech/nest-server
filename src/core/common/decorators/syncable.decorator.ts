/**
 * Decorators for sync-aware models.
 *
 * @SyncField — marks a property with a per-field conflict resolution
 * strategy ('lww' | 'strict'). Default for unmarked fields is 'strict'.
 * The strategy is read by CoreSyncService.tryFieldLevelMerge() at runtime
 * to decide whether to allow a field-level merge before raising 409.
 *
 * Field strategies are stored as Reflect-Metadata. They are NOT enforced
 * by Mongoose itself — the @Restricted decorator and the
 * mongooseRoleGuardPlugin remain authoritative for write protection.
 *
 * @Syncable — convenience class decorator that hints at sync-related
 * configuration. The actual activation happens via Mongoose
 * `@Schema({ syncable: true })`. This decorator is purely for code
 * documentation and reflection (e.g. tooling can list all syncable models).
 */

const SYNC_FIELD_STRATEGY_KEY = 'sync:field-strategy';
const SYNC_CLASS_KEY = 'sync:class';

export type SyncFieldStrategy = 'lww' | 'strict';

export interface SyncableOptions {
  /**
   * Optional model name override. Defaults to class name. Used for
   * lookup-friendly registration if the application uses non-standard
   * naming.
   */
  name?: string;
}

/**
 * Class-level decorator. Currently informational — the actual schema
 * activation happens via `@Schema({ syncable: true })`. Use this in
 * combination with that schema option to make the class additionally
 * discoverable via reflection.
 */
export function Syncable(options: SyncableOptions = {}): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(SYNC_CLASS_KEY, { name: options.name || target.name }, target);
  };
}

/**
 * Property-level decorator that marks a field with a conflict resolution
 * strategy. The strategy is consumed by the sync service when resolving
 * conflicts during bulk push.
 *
 * Strategies:
 *   - 'lww'    Last-Write-Wins per field. Server picks the side with the
 *              newer updatedAt timestamp during a conflict.
 *   - 'strict' (default) — any mismatch in this field aborts the update
 *              with a 409 Conflict, requiring explicit client resolution.
 *
 * Build-time guard: at SyncRegistry-bootstrap, the framework verifies
 * that no field is simultaneously marked `@SyncField('lww')` and
 * `@Restricted(...)` for write — that combination would be misleading
 * because Restricted-write blocks the field anyway.
 */
export function SyncField(strategy: SyncFieldStrategy = 'lww'): PropertyDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(SYNC_FIELD_STRATEGY_KEY, strategy, target, propertyKey);
  };
}

/**
 * Reads the sync-field strategy assigned to a property, if any.
 * Returns 'strict' (default) when no decorator was used.
 */
export function getSyncFieldStrategy(target: any, propertyKey: string | symbol): SyncFieldStrategy {
  return (
    Reflect.getMetadata(SYNC_FIELD_STRATEGY_KEY, target, propertyKey) ||
    Reflect.getMetadata(SYNC_FIELD_STRATEGY_KEY, target.prototype || target, propertyKey) ||
    'strict'
  );
}

/**
 * Lists all properties on a class that have a SyncField strategy declared.
 * Result is a Map<propertyKey, strategy>.
 */
export function getSyncFieldStrategies(target: any): Map<string, SyncFieldStrategy> {
  const result = new Map<string, SyncFieldStrategy>();
  // Iterate own + prototype properties — class-fields land on prototype.
  const proto = target.prototype || target;
  const keys = new Set<string>();
  let cur = proto;
  while (cur && cur !== Object.prototype) {
    Object.getOwnPropertyNames(cur).forEach((k) => keys.add(k));
    cur = Object.getPrototypeOf(cur);
  }
  for (const key of keys) {
    if (key === 'constructor') continue;
    const strategy = Reflect.getMetadata(SYNC_FIELD_STRATEGY_KEY, proto, key);
    if (strategy) {
      result.set(key, strategy);
    }
  }
  return result;
}

/**
 * Internal metadata keys exposed for advanced introspection.
 */
export const SyncMetadataKeys = {
  classKey: SYNC_CLASS_KEY,
  fieldStrategy: SYNC_FIELD_STRATEGY_KEY,
};
