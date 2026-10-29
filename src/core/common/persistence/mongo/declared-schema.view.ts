import { HexObjectId } from './hex-object-id.js';
import {
  type DeclaredSchema,
  declaredProps,
  declaredSchema,
  declaredSchemaOptions,
  isDeclaredSchema,
  RAW_OBJECT_DEFINITION,
} from './model-declarations.js';

/**
 * A declared schema seen the way Mongoose would have built it — the paths, their schema types and the index list —
 * through the members the model descriptor reads (`model-metadata.registry.ts` → `SchemaLike`). So one describer serves
 * both sources, and `tests/unit/persistence-model-descriptor.spec.ts` proves they agree for every model the framework
 * ships: whatever Mongoose derives from a declaration, this derives too, field for field and index for index.
 *
 * What it reproduces, each from Mongoose 9 / `@nestjs/mongoose` 12:
 * - an omitted `type` comes from `design:type` (`Array` → an array of `Mixed`, `Object` → `Mixed`);
 * - a plain nested object (or `raw()`) is a group of dotted paths, a `@Schema()` class a sub-document;
 * - `_id` unless `_id: false`, then the timestamp paths;
 * - a path's index from `index` / `unique` / `sparse` / `expires`, in the order Mongoose applies them; path indexes in
 *   path order with a sub-document's inlined under its prefix, `_autoIndex` where the schema sets `autoIndex`, then
 *   the compound indexes.
 */

/** The members of a Mongoose schema the descriptor reads */
export interface DeclaredSchemaLike {
  eachPath(fn: (path: string, schemaType: any) => void): void;
  get(key: string): unknown;
  indexes(): Array<[Record<string, number | string>, Record<string, unknown>]>;
  path(path: string): unknown;
}

/** Mongoose's index option for a schema's `autoIndex` setting */
const AUTO_INDEX_OPTION = '_autoIndex';

const INSTANCE_BY_CONSTRUCTOR = new Map<unknown, string>([
  [Array, 'Array'],
  [BigInt, 'BigInt'],
  [Boolean, 'Boolean'],
  [Buffer, 'Buffer'],
  [Date, 'Date'],
  [HexObjectId, 'ObjectId'],
  [Map, 'Map'],
  [Number, 'Number'],
  [Object, 'Mixed'],
  [String, 'String'],
]);

/** The Mongoose view of a declared schema */
export function declaredSchemaView(schema: DeclaredSchema): DeclaredSchemaLike {
  const { declaration } = schema;
  const options = { ...declaration.options };
  const definition = declaration.modelClass ? classDefinition(declaration.modelClass) : (declaration.definition ?? {});

  const paths = new Map<string, any>();
  addPaths(paths, definition, '');
  if (options._id !== false && !paths.has('_id')) {
    paths.set('_id', {
      defaultValue: () => undefined,
      instance: 'ObjectId',
      isRequired: false,
      options: { auto: true },
    });
  }
  for (const timestamp of timestampPaths(options.timestamps)) {
    if (!paths.has(timestamp)) {
      paths.set(timestamp, { instance: 'Date', isRequired: false, options: { type: Date } });
    }
  }

  return {
    eachPath: (fn) => paths.forEach((schemaType, path) => fn(path, schemaType)),
    get: (key) => options[key],
    indexes: () => collectIndexes(paths, options, schema.indexes, ''),
    path: (path) => paths.get(path),
  };
}

/** A class's declared properties as a schema definition, with the type `@nestjs/mongoose` infers when it is left out */
function classDefinition(modelClass: abstract new (...args: any[]) => any): Record<string, any> {
  const definition: Record<string, any> = {};
  for (const prop of declaredProps(modelClass)) {
    const { options } = prop;
    if (options[RAW_OBJECT_DEFINITION] || options.type !== undefined || Array.isArray(options)) {
      definition[prop.key] = options;
    } else if (prop.designType === Array) {
      definition[prop.key] = { ...options, type: [] };
    } else {
      definition[prop.key] = {
        ...options,
        type: prop.designType && prop.designType !== Object ? prop.designType : Object,
      };
    }
  }
  return definition;
}

function addPaths(paths: Map<string, any>, definition: Record<string, any>, prefix: string): void {
  for (const [key, value] of Object.entries(definition)) {
    if (isNestedDefinition(value)) {
      addPaths(paths, value, `${prefix}${key}.`);
    } else {
      paths.set(`${prefix}${key}`, schemaTypeOf(value));
    }
  }
}

/** A plain object that declares fields rather than one field's options: Mongoose turns it into dotted paths */
function isNestedDefinition(value: unknown): value is Record<string, any> {
  if (!isPlainObject(value)) {
    return false;
  }
  // An empty definition (`raw({})`, `{}`) declares no fields: Mongoose stores the path as Mixed
  if (!Object.keys(value).length) {
    return false;
  }
  return !!(value as Record<string, unknown>)[RAW_OBJECT_DEFINITION] || !('type' in value);
}

function schemaTypeOf(value: unknown): any {
  const options: Record<string, any> = isPlainObject(value) ? { ...value } : { type: value };
  const type = options.type;

  if (Array.isArray(type)) {
    const element = type[0];
    if (isSchemaClass(element)) {
      return {
        $isMongooseDocumentArray: true,
        defaultValue: () => options.default ?? [],
        instance: 'Array',
        options,
        schema: classView(element),
      };
    }
    if (isNestedDefinition(element)) {
      return {
        $isMongooseDocumentArray: true,
        defaultValue: () => options.default ?? [],
        instance: 'Array',
        options,
        schema: declaredSchemaView(declaredInline(element)),
      };
    }
    const elementOptions: Record<string, any> = isPlainObject(element) ? { ...element } : { type: element ?? Object };
    // Mongoose moves an array's `enum` onto its elements
    if (options.enum !== undefined && elementOptions.enum === undefined) {
      elementOptions.enum = options.enum;
    }
    return {
      pathIndex: indexOf(options, 'Array'),
      // Mongoose wraps every array default in a function, the declared one included
      defaultValue: () => options.default ?? [],
      embeddedSchemaType: scalarSchemaType(elementOptions),
      instance: 'Array',
      isRequired: isRequired(options.required),
      options,
    };
  }
  if (isSchemaClass(type)) {
    return { $isSingleNested: true, instance: 'Embedded', options, schema: classView(type) };
  }
  return scalarSchemaType(options);
}

function scalarSchemaType(options: Record<string, any>): any {
  const instance = instanceOf(options.type);
  const schemaType: Record<string, any> = {
    pathIndex: indexOf(options, instance),
    defaultValue: instance === 'Mixed' ? mixedDefault(options.default) : options.default,
    instance,
    isRequired: isRequired(options.required),
    options,
  };
  if (instance === 'String') {
    schemaType.enumValues = enumValues(options.enum);
  }
  return schemaType;
}

/** Mongoose's `Mixed` turns an empty `[]` or `{}` default into a function, so instances do not share one object */
function mixedDefault(value: unknown): unknown {
  if (Array.isArray(value) && !value.length) {
    return Array;
  }
  return isPlainObject(value) && !Object.keys(value).length ? () => ({}) : value;
}

function instanceOf(type: unknown): string {
  if (typeof type === 'string') {
    return type;
  }
  const known = INSTANCE_BY_CONSTRUCTOR.get(type);
  if (known) {
    return known;
  }
  // Mongoose's own schema types name themselves (`Schema.Types.ObjectId.schemaName === 'ObjectId'`)
  const schemaName = (type as { schemaName?: unknown })?.schemaName;
  return typeof schemaName === 'string' ? schemaName : 'Mixed';
}

function enumValues(declared: unknown): unknown[] {
  if (Array.isArray(declared)) {
    return [...declared];
  }
  const values = (declared as { values?: unknown })?.values;
  if (Array.isArray(values)) {
    return [...values];
  }
  // Mongoose reads an object's values last key first (`utils.object.vals`)
  return declared && typeof declared === 'object' ? Object.values(declared).reverse() : [];
}

function isRequired(required: unknown): boolean {
  if (Array.isArray(required)) {
    return !!required[0];
  }
  return typeof required === 'function' || !!required;
}

/** A path's index as Mongoose's schema type records it (`SchemaType#_index`, kept here as `pathIndex`), from its options in declaration order */
function indexOf(options: Record<string, any>, instance: string): unknown {
  let index: any = null;
  for (const key of Object.keys(options)) {
    const value = options[key];
    if (key === 'index') {
      if (index) {
        continue;
      }
      index = isPlainObject(value) ? withExpiry({ ...value }) : value;
    } else if (key === 'unique' || key === 'sparse') {
      if (index === false || (value === false && !('index' in options))) {
        continue;
      }
      index =
        index === null || index === undefined || index === true
          ? {}
          : typeof index === 'string'
            ? { type: index }
            : index;
      index[key] = !!(Array.isArray(value) ? value[0] : value);
    } else if (key === 'expires' && instance === 'Date') {
      index = isPlainObject(index) ? index : {};
      index.expires = value;
      withExpiry(index);
    }
  }
  return index;
}

/** `expires` → `expireAfterSeconds`, a duration string read like Mongoose's `ms` */
function withExpiry(index: Record<string, any>): Record<string, any> {
  if ('expires' in index) {
    index.expireAfterSeconds =
      typeof index.expires === 'string' ? Math.round(durationMs(index.expires) / 1000) : index.expires;
    delete index.expires;
  }
  return index;
}

const DURATION_UNITS: Array<[RegExp, number]> = [
  [/^(ms|msecs?|milliseconds?)$/, 1],
  [/^(s|secs?|seconds?)$/, 1000],
  [/^(m|mins?|minutes?)$/, 60_000],
  [/^(h|hrs?|hours?)$/, 3_600_000],
  [/^(d|days?)$/, 86_400_000],
  [/^(w|weeks?)$/, 604_800_000],
  [/^(y|yrs?|years?)$/, 31_557_600_000],
];

function durationMs(value: string): number {
  const match = /^(-?\d*\.?\d+) *([a-z]*)$/i.exec(value.trim());
  if (!match) {
    return Number.NaN;
  }
  const unit = match[2].toLowerCase();
  const factor = unit ? DURATION_UNITS.find(([pattern]) => pattern.test(unit))?.[1] : 1;
  return factor === undefined ? Number.NaN : Number(match[1]) * factor;
}

/** Mongoose's `getIndexes()`: path indexes in path order, a sub-document's under its prefix, then the compound ones */
function collectIndexes(
  paths: Map<string, any>,
  options: Record<string, any>,
  compound: Array<[Record<string, number | string>, Record<string, unknown>]>,
  prefix: string,
): Array<[Record<string, number | string>, Record<string, unknown>]> {
  const indexes: Array<[Record<string, number | string>, Record<string, unknown>]> = [];
  for (const [key, schemaType] of paths) {
    if ((schemaType.$isMongooseDocumentArray || schemaType.$isSingleNested) && schemaType.schema) {
      indexes.push(...subIndexes(schemaType.schema, `${prefix}${key}.`));
      if (schemaType.$isMongooseDocumentArray) {
        continue;
      }
    }
    const index = schemaType.pathIndex ?? schemaType.embeddedSchemaType?.pathIndex;
    if (index === false || index === null || index === undefined) {
      continue;
    }
    const indexOptions: Record<string, unknown> = isPlainObject(index) ? { ...index } : {};
    const descending = index === 'descending' || index === 'desc' || Number(index) === -1;
    delete indexOptions.type;
    if (options.autoIndex !== undefined && options.autoIndex !== null) {
      // Mongoose's own option name for a path index of a schema that sets `autoIndex`
      indexOptions[AUTO_INDEX_OPTION] = options.autoIndex;
    }
    indexes.push([{ [`${prefix}${key}`]: descending ? -1 : 1 }, indexOptions]);
  }
  return [
    ...indexes,
    ...compound.map(([fields, indexOptions]) => [{ ...fields }, { ...indexOptions }] as (typeof compound)[number]),
  ];
}

/** A sub-document's indexes under its prefix — its compound ones included, prefixed too */
function subIndexes(view: DeclaredSchemaLike, prefix: string) {
  return view.indexes().map(([fields, options]) => {
    const prefixed: Record<string, number | string> = {};
    for (const [field, direction] of Object.entries(fields)) {
      prefixed[field.startsWith(prefix) ? field : `${prefix}${field}`] = direction;
    }
    return [prefixed, { ...options }] as [Record<string, number | string>, Record<string, unknown>];
  });
}

function timestampPaths(timestamps: unknown): string[] {
  if (timestamps === true) {
    return ['createdAt', 'updatedAt'];
  }
  if (isPlainObject(timestamps)) {
    const config = timestamps as { createdAt?: boolean | string; updatedAt?: boolean | string };
    const name = (option: boolean | string | undefined, fallback: string) =>
      option === false ? undefined : typeof option === 'string' ? option : fallback;
    return [name(config.createdAt, 'createdAt'), name(config.updatedAt, 'updatedAt')].filter(
      (path): path is string => !!path,
    );
  }
  return [];
}

/**
 * A field's computed default (a function, or the function Mixed makes of `{}` / `[]`) as Mongoose's
 * `SchemaType.getDefault()` computes it — for a Mongoose schema and a declared one alike, since a declared schema (the
 * model class without Mongoose installed) has no `path().getDefault()`. Not cast: the store casts it for its column.
 */
export function computedDefault(
  schema: DeclaredSchema | { path(name: string): any },
  path: string,
  doc: Record<string, any>,
): unknown {
  if (!isDeclaredSchema(schema)) {
    return schema.path(path)?.getDefault?.(doc);
  }
  const defaultValue = (declaredSchemaView(schema).path(path) as undefined | { defaultValue?: unknown })?.defaultValue;
  if (typeof defaultValue !== 'function') {
    return defaultValue;
  }
  // As Mongoose calls it: `Date.now` without arguments, every other default with the document as `this` and argument
  return defaultValue === Date.now ? Date.now() : defaultValue.call(doc, doc);
}

function isSchemaClass(value: unknown): value is abstract new (...args: any[]) => any {
  return typeof value === 'function' && declaredSchemaOptions(value) !== undefined;
}

function classView(modelClass: abstract new (...args: any[]) => any): DeclaredSchemaLike {
  return declaredSchemaView(declaredSchema(modelClass));
}

function declaredInline(definition: Record<string, any>): DeclaredSchema {
  return { declaration: { definition }, indexes: [] } as unknown as DeclaredSchema;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  );
}
