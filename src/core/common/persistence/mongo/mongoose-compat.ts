import { Inject } from '@nestjs/common';
import type { Query } from 'mongoose';

import { HexObjectId } from './hex-object-id.js';
import {
  DeclaredSchema,
  declaredSchema,
  markRaw,
  recordModelDeclaration,
  recordPropDeclaration,
} from './model-declarations.js';
import { optionalMongoPackages, requireMongoPackages } from './mongo-packages.js';

/**
 * The parts of `@nestjs/mongoose` and `mongoose` the core declares its models, injections and ids with — usable
 * whether or not MongoDB's libraries are installed (`mongo-packages.ts`). Since 12.1.0 the same names are exported for
 * projects: a model file that imports `Prop`, `Schema` and `SchemaFactory` from `@lenne.tech/nest-server` works on
 * MongoDB and on PostgreSQL alike, and installs nothing of MongoDB's where it is not used.
 *
 * - The decorators always RECORD what they declare (`model-declarations.ts`): that record is where a model's
 *   descriptor comes from when Mongoose is not there to build a schema. With Mongoose installed they also apply the
 *   real decorator, at the moment the original would have run — so a project's own `SchemaFactory.createForClass()`
 *   sees the core's fields exactly as before.
 * - The injection tokens are computed here, identically to `@nestjs/mongoose` (pinned by
 *   `tests/unit/mongoose-compat.spec.ts`): a token is a string, and a service of the core must be constructible in a
 *   project that has no MongoDB at all.
 */

/** `@nestjs/mongoose`'s name for the default connection */
export const DEFAULT_CONNECTION_NAME = 'DatabaseConnection';

/** The DI token of a connection — `getConnectionToken()` of `@nestjs/mongoose` */
export function getConnectionToken(name?: string): string {
  return name && name !== DEFAULT_CONNECTION_NAME ? `${name}Connection` : DEFAULT_CONNECTION_NAME;
}

/** The DI token of a model — `getModelToken()` of `@nestjs/mongoose` */
export function getModelToken(model: string, connectionName?: string): string {
  return connectionName === undefined ? `${model}Model` : `${getConnectionToken(connectionName)}/${model}Model`;
}

/**
 * `@InjectModel()` — the model's Mongoose model where MongoDB is installed, else a stand-in that refuses data access;
 * either way bound to the model's data store, which a `CrudService` follows (`CorePersistenceModule.forFeature()`)
 */
export function InjectModel(model: string, connectionName?: string): ParameterDecorator & PropertyDecorator {
  return Inject(getModelToken(model, connectionName));
}

/** `@InjectConnection()` — the Mongoose connection, `null` where no MongoDB is configured */
export function InjectConnection(name?: string): ParameterDecorator & PropertyDecorator {
  return Inject(getConnectionToken(name));
}

/** `@Schema()` of `@nestjs/mongoose` */
export function Schema(options?: Record<string, any>): ClassDecorator {
  return (target) => {
    recordModelDeclaration(target, options);
    optionalMongoPackages()?.nestMongoose.Schema(options as any)(target);
  };
}

/** `@Prop()` of `@nestjs/mongoose` */
export function Prop(options?: Record<string, any>): PropertyDecorator {
  return (target, propertyKey) => {
    recordPropDeclaration(target, propertyKey, options);
    optionalMongoPackages()?.nestMongoose.Prop(options as any)(target, propertyKey);
  };
}

/** `raw()` of `@nestjs/mongoose` — an inline object definition, kept as written where Mongoose is not installed */
export function raw(definition: Record<string, any>): Record<string, any> {
  const packages = optionalMongoPackages();
  return packages ? packages.nestMongoose.raw(definition) : markRaw(definition);
}

/**
 * `SchemaFactory.createForClass()` of `@nestjs/mongoose` — the Mongoose schema, or the recorded declaration
 * (`DeclaredSchema`) where Mongoose is not installed
 */
export const SchemaFactory = {
  createForClass(target: abstract new (...args: any[]) => any): any {
    const packages = optionalMongoPackages();
    return packages ? packages.nestMongoose.SchemaFactory.createForClass(target as any) : declaredSchema(target);
  },
};

/**
 * `new Schema(definition, options)` of `mongoose` — for a model declared inline rather than through a class. A field
 * whose shape is free-form is declared `{ type: Object }`, which Mongoose stores as `Mixed`.
 */
export function createSchema(definition: Record<string, any>, options: Record<string, any> = {}): any {
  const packages = optionalMongoPackages();
  return packages
    ? new packages.mongoose.Schema(definition, options)
    : new DeclaredSchema({ definition: { ...definition }, options: { ...options } });
}

/**
 * The type to declare an ObjectId field with (`@Prop({ type: ObjectIdType, ref })`): Mongoose's `Schema.Types.ObjectId`
 * where installed, else the class the descriptor recognises as an id
 */
export function objectIdType(): unknown {
  return optionalMongoPackages()?.mongoose.Schema.Types.ObjectId ?? HexObjectId;
}

/** A new ObjectId, or one for the given hex string / ObjectId — `new Types.ObjectId(value)` */
export function newObjectId(value?: { toHexString(): string } | string): any {
  const packages = optionalMongoPackages();
  return packages ? new packages.mongoose.Types.ObjectId(value as any) : new HexObjectId(value);
}

/** `Types.ObjectId.isValid()` — accepts what an ObjectId can be built from */
export function isValidObjectId(value: unknown): boolean {
  const packages = optionalMongoPackages();
  return packages ? packages.mongoose.Types.ObjectId.isValid(value as any) : HexObjectId.isValid(value);
}

/** Whether a value is a Mongoose query (`instanceof Query`) — never where Mongoose is not installed */
export function isMongooseQuery(value: unknown): value is Query<any, any> {
  const Query = optionalMongoPackages()?.mongoose.Query;
  return !!Query && value instanceof Query;
}

/** A GridFS bucket on a MongoDB database — GridFS IS MongoDB, so its absence is a configuration error, named as such */
export function createGridFsBucket(db: unknown, options?: { bucketName?: string }): any {
  const { mongodb } = requireMongoPackages('GridFS (file.storage: gridfs)');
  return new mongodb.GridFSBucket(db as any, options);
}
