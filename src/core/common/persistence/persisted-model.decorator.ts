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
 * Every class decorated with `@PersistedModel`, by class name. `SchemaFactory.createForClass()` keeps no reference to
 * its class, so a model registered as `{ name, schema }` is matched to its declaration through the name
 */
const declaredByName = new Map<string, Function[]>();

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
    const classes = declaredByName.get(target.name) ?? [];
    if (!classes.includes(target)) {
      declaredByName.set(target.name, [...classes, target]);
    }
  };
}

/** The options a class declared with `@PersistedModel` (inherited from a parent class), if any. */
export function getPersistedModelOptions(target: Function): PersistedModelOptions | undefined {
  return Reflect.getMetadata(PERSISTED_MODEL_OPTIONS, target);
}

/**
 * The options declared for the model registered under `name` without its class: those of the `@PersistedModel` class
 * of that name. Two decorated classes of that name that name different sources cannot be told apart — the
 * registration must pass `model:` (or `dataSource:`) then, so this throws instead of guessing.
 */
export function getPersistedModelOptionsByName(name: string): PersistedModelOptions | undefined {
  const classes = declaredByName.get(name) ?? [];
  const sources = new Set(classes.map((target) => getPersistedModelOptions(target)?.dataSource));
  if (sources.size > 1) {
    throw new Error(
      `@PersistedModel: ${classes.length} classes named "${name}" declare different data sources; pass \`model\` ` +
        `(or \`dataSource\`) in CorePersistenceModule.forFeature() to say which one this model is`,
    );
  }
  return classes.length ? getPersistedModelOptions(classes[0]) : undefined;
}
