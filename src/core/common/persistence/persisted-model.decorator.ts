/**
 * Persistence options a model class declares in code.
 */
export interface PersistedModelOptions {
  /**
   * Name of the data source the model is stored in (a key of `database.sources`). The configuration's
   * `database.models` wins over this declaration, so operations can move a model without a code change.
   * @default the default source
   */
  dataSource?: string;
}

const PERSISTED_MODEL_OPTIONS = Symbol('PERSISTED_MODEL_OPTIONS');

/**
 * Declare where a model is stored.
 *
 * @example
 * ```typescript
 * @PersistedModel({ dataSource: 'logs' })
 * @Schema({ timestamps: true })
 * export class AuditEntry extends CorePersistenceModel { … }
 * ```
 */
export function PersistedModel(options: PersistedModelOptions): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(PERSISTED_MODEL_OPTIONS, { ...options }, target);
  };
}

/** The options a class declared with `@PersistedModel` (inherited from a parent class), if any. */
export function getPersistedModelOptions(target: Function): PersistedModelOptions | undefined {
  return Reflect.getMetadata(PERSISTED_MODEL_OPTIONS, target);
}
