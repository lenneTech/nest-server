import { SchemaFactory } from '@nestjs/mongoose';

import type { FieldDescriptor, FieldKind, IndexDescriptor, ModelDescriptor } from './model-descriptor.interface.js';

/**
 * Registry of database-neutral model descriptors.
 *
 * The descriptors are derived from the model's Mongoose schema, which is what MongoDB stores today
 * and therefore the most faithful source: it covers fields declared through `@UnifiedField({ mongoose })`
 * and through a plain `@Prop()` alike, which consumer projects mix freely. `SchemaFactory.createForClass`
 * works without a connection, so a descriptor exists before any database is reached.
 *
 * Only the schema's own declarations are read — never documents — so describing a model is free of
 * side effects and safe at boot.
 */

const descriptorsByName = new Map<string, ModelDescriptor>();
const descriptorsByClass = new WeakMap<object, ModelDescriptor>();

/** Mongoose's version key is bookkeeping of the Mongo driver, not model data. */
const IGNORED_PATHS = new Set(['__v']);

/**
 * Minimal structural view of a Mongoose schema — `import type` would tie the descriptor to the
 * installed mongoose version's generics, and only these members are read.
 */
interface SchemaLike {
  eachPath(fn: (path: string, schemaType: any) => void): unknown;
  get(key: string): unknown;
  indexes(): Array<[Record<string, number | string>, Record<string, unknown>?]>;
  path(path: string): unknown;
}

/**
 * Describe a schema under the given model name.
 */
export function describeSchema(name: string, schema: SchemaLike): ModelDescriptor {
  const indexes = describeIndexes(schema);
  const descriptor: ModelDescriptor = {
    fields: describeFields(schema, indexes),
    indexes,
    name,
    tenantScoped: !!schema.path('tenantId'),
    timestamps: describeTimestamps(schema.get('timestamps')),
  };
  const collection = schema.get('collection');
  if (typeof collection === 'string' && collection) {
    descriptor.collection = collection;
  }
  return descriptor;
}

/**
 * Describe a model class (decorated with `@Schema()`), cached per class.
 *
 * The model name is the class name — the name `MongooseModule.forFeature([{ name: X.name, … }])` uses.
 */
export function describeModelClass(modelClass: abstract new (...args: any[]) => any): ModelDescriptor {
  const cached = descriptorsByClass.get(modelClass);
  if (cached) {
    return cached;
  }
  const descriptor = describeSchema(modelClass.name, SchemaFactory.createForClass(modelClass as any));
  descriptorsByClass.set(modelClass, descriptor);
  return descriptor;
}

/**
 * Register the schema a model is persisted with, under its model name. A later registration under
 * the same name replaces the earlier one — the last `forFeature` wins, as it does in Mongoose.
 */
export function registerModelSchema(name: string, schema: SchemaLike): ModelDescriptor {
  const descriptor = describeSchema(name, schema);
  descriptorsByName.set(name, descriptor);
  return descriptor;
}

/** The descriptor registered under a model name, if any. */
export function getModelDescriptor(name: string): ModelDescriptor | undefined {
  return descriptorsByName.get(name);
}

/** Every registered descriptor, keyed by model name. */
export function getModelDescriptors(): ReadonlyMap<string, ModelDescriptor> {
  return descriptorsByName;
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

function describeIndexes(schema: SchemaLike): IndexDescriptor[] {
  return schema.indexes().map(([fields, options]) => ({ fields: { ...fields }, options: { ...options } }));
}

function describeTimestamps(value: unknown): ModelDescriptor['timestamps'] {
  if (value && typeof value === 'object') {
    const config = value as { createdAt?: boolean | string; updatedAt?: boolean | string };
    const name = (option: boolean | string | undefined, fallback: string): false | string =>
      option === false ? false : typeof option === 'string' ? option : fallback;
    return { createdAt: name(config.createdAt, 'createdAt'), updatedAt: name(config.updatedAt, 'updatedAt') };
  }
  return value === true;
}

/**
 * Collect the schema's paths into fields. Dotted paths of a raw nested object (`{ meta: { score } }`
 * becomes `meta.score`) are grouped back into one object field, because that is what is stored: one
 * embedded object, not columns named with dots.
 */
function describeFields(schema: SchemaLike, indexes: IndexDescriptor[]): Record<string, FieldDescriptor> {
  const entries: Array<[string, any]> = [];
  schema.eachPath((path, schemaType) => {
    // `labels.$*` is the value type of a Map, which the Map field itself already stands for
    if (IGNORED_PATHS.has(path) || path.includes('$*')) {
      return;
    }
    entries.push([path, schemaType]);
  });
  return buildFields(entries, indexes, '');
}

function buildFields(
  entries: Array<[string, any]>,
  indexes: IndexDescriptor[],
  prefix: string,
): Record<string, FieldDescriptor> {
  const fields: Record<string, FieldDescriptor> = {};
  const groups = new Map<string, Array<[string, any]>>();
  for (const [path, schemaType] of entries) {
    const dot = path.indexOf('.');
    if (dot === -1) {
      fields[path] = describeField(path, schemaType, indexes, `${prefix}${path}`);
      continue;
    }
    const head = path.slice(0, dot);
    const group = groups.get(head) ?? [];
    group.push([path.slice(dot + 1), schemaType]);
    groups.set(head, group);
  }
  for (const [head, group] of groups) {
    fields[head] = clean({
      ...baseField(head),
      kind: 'object',
      nested: buildFields(group, indexes, `${prefix}${head}.`),
    });
  }
  return fields;
}

function describeField(name: string, schemaType: any, indexes: IndexDescriptor[], fullPath: string): FieldDescriptor {
  const options: Record<string, any> = schemaType?.options ?? {};
  const field: FieldDescriptor = {
    ...baseField(name),
    ...describeKind(schemaType, options),
    lowercase: options.lowercase === true,
    renamedFrom: typeof options.renamedFrom === 'string' ? options.renamedFrom : undefined,
    required: !!schemaType?.isRequired,
    select: options.select !== false,
    sparse: !!options.sparse,
    trim: options.trim === true,
    unique: options.unique === true || (Array.isArray(options.unique) && options.unique[0] === true),
  };

  const defaultValue = schemaType?.defaultValue ?? options.default;
  if (defaultValue !== undefined) {
    field.hasDefault = true;
    if (typeof defaultValue !== 'function') {
      field.default = defaultValue;
    }
  }

  // Read the TTL from the schema's index list: Mongoose has already turned `expires: '1h'` into seconds there
  const ttl = indexes.find(
    (index) =>
      Object.keys(index.fields).length === 1 && fullPath in index.fields && 'expireAfterSeconds' in index.options,
  );
  if (ttl) {
    field.expiresAfterSeconds = Number(ttl.options.expireAfterSeconds);
  }
  field.index = !!options.index || field.unique || !!ttl;

  return clean(field);
}

function baseField(name: string): FieldDescriptor {
  return {
    hasDefault: false,
    index: false,
    isArray: false,
    kind: 'json',
    lowercase: false,
    name,
    required: false,
    select: true,
    sparse: false,
    trim: false,
    unique: false,
  };
}

type KindPart = Pick<FieldDescriptor, 'enumBase' | 'enumValues' | 'isArray' | 'kind' | 'nested' | 'ref'>;

function describeKind(schemaType: any, options: Record<string, any>): KindPart {
  // An array of sub-documents declared with @Schema
  if (schemaType?.$isMongooseDocumentArray && schemaType.schema) {
    return { isArray: true, kind: 'object', nested: nestedFields(schemaType.schema) };
  }
  // A single sub-document declared with @Schema
  if (schemaType?.$isSingleNested && schemaType.schema) {
    return { isArray: false, kind: 'object', nested: nestedFields(schemaType.schema) };
  }
  if (schemaType?.instance === 'Array') {
    const element = schemaType.embeddedSchemaType ?? schemaType.caster;
    // An array of arrays has no column shape; it is stored as JSON
    if (!element || element.instance === 'Array') {
      return { isArray: false, kind: 'json' };
    }
    return { ...scalarKind(element, element.options ?? {}), isArray: true };
  }
  return { ...scalarKind(schemaType, options), isArray: false };
}

function scalarKind(schemaType: any, options: Record<string, any>): Omit<KindPart, 'isArray'> {
  // A reference is recognised by its declaration, not by its type: `type: Types.ObjectId` (the bson
  // class rather than `Schema.Types.ObjectId`) makes Mongoose report the path as Mixed, yet it is a ref.
  if (options.ref !== undefined || options.refPath !== undefined) {
    const ref = typeof options.ref === 'string' ? options.ref : options.ref?.modelName;
    return ref ? { kind: 'ref', ref } : { kind: 'ref' };
  }
  const instance: string | undefined = schemaType?.instance;
  if (instance === 'String' || instance === 'Number') {
    const base = instance === 'String' ? 'string' : 'number';
    const values = enumValuesOf(schemaType, options, base);
    return values ? { enumBase: base, enumValues: values, kind: 'enum' } : { kind: base };
  }
  const kinds: Record<string, FieldKind> = {
    BigInt: 'bigint',
    Boolean: 'boolean',
    Buffer: 'buffer',
    Date: 'date',
    Decimal128: 'decimal',
    Double: 'number',
    Int32: 'number',
    ObjectId: 'id',
    UUID: 'uuid',
  };
  // Mixed, Map and anything unknown carry no declared shape
  return { kind: (instance && kinds[instance]) || 'json' };
}

function enumValuesOf(schemaType: any, options: Record<string, any>, base: 'number' | 'string'): unknown[] | undefined {
  if (Array.isArray(schemaType?.enumValues) && schemaType.enumValues.length) {
    return [...schemaType.enumValues];
  }
  const declared = options.enum?.values ?? options.enum;
  if (Array.isArray(declared)) {
    return declared.length ? [...declared] : undefined;
  }
  if (declared && typeof declared === 'object') {
    // A TypeScript numeric enum maps both ways (`{ A: 0, 0: 'A' }`): keep only the values of the base type
    const values = Object.values(declared).filter((value) => typeof value === base);
    return values.length ? values : undefined;
  }
  return undefined;
}

function nestedFields(schema: SchemaLike): Record<string, FieldDescriptor> {
  return describeFields(schema, describeIndexes(schema));
}

/** Drop optional keys that are `undefined`, so descriptors compare and print without noise. */
function clean(field: FieldDescriptor): FieldDescriptor {
  for (const key of Object.keys(field) as Array<keyof FieldDescriptor>) {
    if (field[key] === undefined) {
      delete field[key];
    }
  }
  return field;
}
