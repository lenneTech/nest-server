/**
 * What the core's model classes declare through `@Schema()` / `@Prop()` (and `@UnifiedField({ mongoose })`, which
 * applies `@Prop()`), recorded independently of Mongoose — the source of a model's descriptor where MongoDB's libraries
 * are not installed (`model-metadata.registry.ts` → `describeDeclaredSchema()`).
 *
 * The record keeps the options exactly as written plus the property's `design:type`, which is what `@nestjs/mongoose`
 * reads to infer a type that `type` leaves out. Import-free leaf (apart from `reflect-metadata`'s global `Reflect`),
 * because every model file reaches it through the decorators.
 */

/** `@nestjs/mongoose`'s marker of a `raw()` definition: a non-enumerable property of that name */
export const RAW_OBJECT_DEFINITION = 'RAW_OBJECT_DEFINITION';

/** Mark a definition as `raw()` does, without making the marker a field */
export function markRaw<T extends object>(definition: T): T {
  Object.defineProperty(definition, RAW_OBJECT_DEFINITION, { configurable: false, enumerable: false, value: true });
  return definition;
}

/** One declared property */
export interface DeclaredProp {
  /** `design:type` of the property, as TypeScript emitted it */
  designType: unknown;
  key: string;
  options: Record<string, any>;
}

/** `@Schema()` options per class; a class without an entry was never decorated with `@Schema()` */
const schemaOptions = new WeakMap<object, Record<string, any>>();
/** `@Prop()` declarations per prototype, in declaration order */
const props = new WeakMap<object, Map<string, DeclaredProp>>();

export function recordModelDeclaration(target: object, options: Record<string, any> | undefined): void {
  schemaOptions.set(target, { ...options });
}

export function recordPropDeclaration(prototype: object, propertyKey: string | symbol, options: unknown): void {
  if (typeof propertyKey !== 'string') {
    return;
  }
  const declared = props.get(prototype) ?? new Map<string, DeclaredProp>();
  const copy: Record<string, any> =
    options && typeof options === 'object' && !Array.isArray(options) ? { ...options } : { type: options ?? undefined };
  if (copy.type === undefined && !(options && typeof options === 'object' && !Array.isArray(options))) {
    delete copy.type;
  }
  // `raw()` marks its definition with a non-enumerable flag, which a spread drops
  if ((options as Record<string, unknown> | undefined)?.[RAW_OBJECT_DEFINITION]) {
    markRaw(copy);
  }
  declared.set(propertyKey, {
    designType: Reflect.getMetadata('design:type', prototype, propertyKey),
    key: propertyKey,
    options: copy,
  });
  props.set(prototype, declared);
}

/** The `@Schema()` options of a class, `undefined` when it has no `@Schema()` */
export function declaredSchemaOptions(modelClass: object): Record<string, any> | undefined {
  return schemaOptions.get(modelClass);
}

/**
 * Every property a class declares, its ancestors' first — a subclass's declaration of a property replaces the
 * inherited one, as `SchemaFactory.createForClass()` merges them.
 */
export function declaredProps(modelClass: abstract new (...args: any[]) => any): DeclaredProp[] {
  const chain: object[] = [];
  for (let prototype = modelClass.prototype; prototype && prototype !== Object.prototype;) {
    chain.unshift(prototype);
    prototype = Object.getPrototypeOf(prototype);
  }
  const merged = new Map<string, DeclaredProp>();
  for (const prototype of chain) {
    for (const [key, declared] of props.get(prototype) ?? []) {
      merged.set(key, declared);
    }
  }
  return [...merged.values()];
}

/**
 * A schema as declared, where Mongoose is not installed to build one: a model class (`SchemaFactory.createForClass()`)
 * or an inline definition (`createSchema()`), plus the compound indexes registered on it. The schema methods a model
 * file calls after creating it are accepted: `index()` is recorded (the SQL store creates the index), the others
 * configure Mongoose's document lifecycle, which does not exist without Mongoose.
 */
export class DeclaredSchema {
  readonly indexes: Array<[Record<string, number | string>, Record<string, unknown>]> = [];

  constructor(
    readonly declaration: {
      definition?: Record<string, any>;
      modelClass?: abstract new (...args: any[]) => any;
      options?: Record<string, any>;
    },
  ) {}

  index(fields: Record<string, number | string>, options: Record<string, unknown> = {}): this {
    this.indexes.push([{ ...fields }, { ...options }]);
    return this;
  }

  plugin(): this {
    return this;
  }

  post(): this {
    return this;
  }

  pre(): this {
    return this;
  }

  set(): this {
    return this;
  }

  virtual(): { get: () => unknown; set: () => unknown } {
    const virtual = { get: () => virtual, set: () => virtual };
    return virtual;
  }
}

/** The declared schema of a model class */
export function declaredSchema(modelClass: abstract new (...args: any[]) => any): DeclaredSchema {
  return new DeclaredSchema({ modelClass, options: declaredSchemaOptions(modelClass) });
}

/** Whether a value is a declared schema rather than a Mongoose one */
export function isDeclaredSchema(schema: unknown): schema is DeclaredSchema {
  return schema instanceof DeclaredSchema;
}
