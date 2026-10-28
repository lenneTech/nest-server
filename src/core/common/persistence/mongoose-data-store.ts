import { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';

import { getStringIds } from '../helpers/id.helper.js';
import { assertAccessReason, assertArrayField, assertSelectFields } from './store-guards.js';
import type {
  DataStore,
  DataStoreUpdate,
  FindOptions,
  PushOptions,
  StoreCapabilities,
  StoredRecord,
  Where,
} from './data-store.interface.js';

/** What MongoDB offers through Mongoose. Transactions need a replica set and are not assumed. */
export const MONGOOSE_STORE_CAPABILITIES: Readonly<StoreCapabilities> = Object.freeze({
  aggregatePipeline: true,
  changeFeed: false,
  gridfs: true,
  idType: 'objectId',
  mongoosePopulate: true,
  rawFilterArm: true,
  rls: false,
  textSearch: true,
  transactions: false,
});

/**
 * The MongoDB data store: the neutral port over a Mongoose model.
 *
 * Every operation runs through a Model method, never the native collection, so the security plugins
 * (tenant isolation before and after, audit fields, role guard, system roles, password hashing) fire
 * exactly as for any other Mongoose call. Filters and updates pass through untouched — they already
 * are the Mongo-operator form — except that the neutral `id` is addressed as `_id`.
 */
export class MongooseDataStore<T = Record<string, any>> implements DataStore<T> {
  readonly capabilities = MONGOOSE_STORE_CAPABILITIES;
  readonly driver = 'mongodb';
  protected readonly logger = new Logger(MongooseDataStore.name);

  constructor(protected readonly model: Model<any>) {}

  get modelName(): string {
    return this.model.modelName;
  }

  async count(where?: Where<T>): Promise<number> {
    return this.model.countDocuments(toMongoFilter(where)).exec();
  }

  async deleteById(id: string): Promise<null | StoredRecord<T>> {
    return toRecord<T>(await this.model.findByIdAndDelete(id).lean().exec());
  }

  async distinct(field: string, where?: Where<T>): Promise<unknown[]> {
    return this.model.distinct(field, toMongoFilter(where)).exec();
  }

  async find(where?: Where<T>, options: FindOptions = {}): Promise<StoredRecord<T>[]> {
    let query = this.model.find(toMongoFilter(where));
    if (options.select) query = query.select(toProjection(options.select));
    if (options.sort) query = query.sort(options.sort);
    if (options.skip !== undefined) query = query.skip(options.skip);
    if (options.limit !== undefined) query = query.limit(options.limit);
    if (options.collation) query = query.collation(options.collation as any);
    const docs = await query.lean().exec();
    return (docs as unknown[]).map((doc) => toRecord<T>(doc));
  }

  async findById(id: string, options: Pick<FindOptions, 'select'> = {}): Promise<null | StoredRecord<T>> {
    let query = this.model.findById(id);
    if (options.select) query = query.select(toProjection(options.select));
    return toRecord<T>(await query.lean().exec());
  }

  async findOne(where: Where<T>, options: Omit<FindOptions, 'limit' | 'skip'> = {}): Promise<null | StoredRecord<T>> {
    let query = this.model.findOne(toMongoFilter(where));
    if (options.select) query = query.select(toProjection(options.select));
    if (options.sort) query = query.sort(options.sort);
    if (options.collation) query = query.collation(options.collation as any);
    return toRecord<T>(await query.lean().exec());
  }

  async insert(record: Partial<T>): Promise<StoredRecord<T>> {
    // `create()` runs the save hooks, so tenant stamping, audit fields and password hashing apply
    const created = await this.model.create(record);
    return toRecord<T>(created.toObject());
  }

  native<N = unknown>(reason: string): N {
    assertAccessReason(reason, 'native');
    this.logger.debug(`Native model access: ${reason} (Model: ${this.modelName})`);
    return this.model as unknown as N;
  }

  async pullFromArray(id: string, field: string, condition: unknown): Promise<void> {
    assertArrayField(field, 'pullFromArray');
    await this.model
      .findByIdAndUpdate(id, { $pull: { [field]: condition } } as any)
      .lean()
      .exec();
  }

  async pushToArray(id: string, field: string, items: readonly unknown[], options: PushOptions = {}): Promise<void> {
    assertArrayField(field, 'pushToArray');
    if (!items.length) {
      return;
    }
    const push: Record<string, unknown> = { $each: [...items] };
    if (options.slice !== undefined) push.$slice = options.slice;
    if (options.position !== undefined) push.$position = options.position;
    if (options.sort) push.$sort = options.sort;
    await this.model
      .findByIdAndUpdate(id, { $push: { [field]: push } } as any)
      .lean()
      .exec();
  }

  raw<N = unknown>(reason: string): N {
    assertAccessReason(reason, 'raw');
    this.logger.warn(`[SECURITY] Native collection access: ${reason} (Model: ${this.modelName})`);
    return this.model.collection as unknown as N;
  }

  async updateById(id: string, update: DataStoreUpdate<T>): Promise<null | StoredRecord<T>> {
    const updated = await this.model
      .findByIdAndUpdate(id, update as any, { returnDocument: 'after' })
      .lean()
      .exec();
    return toRecord<T>(updated);
  }
}

/** The neutral `id` is `_id` in MongoDB — at the top level and inside `$and` / `$or` / `$nor`. */
export function toMongoFilter(where: undefined | Where<any>): Record<string, any> {
  if (!where) {
    return {};
  }
  const filter: Record<string, any> = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === 'id') {
      filter._id = value;
    } else if ((key === '$and' || key === '$or' || key === '$nor') && Array.isArray(value)) {
      filter[key] = value.map((entry) => toMongoFilter(entry));
    } else {
      filter[key] = value;
    }
  }
  return filter;
}

/** A lean document as a neutral record: the id as a string under `id`, no `_id`, no version key. */
function toRecord<T>(doc: unknown): StoredRecord<T> {
  if (!doc) {
    return null;
  }
  const { __v: _version, _id, ...fields } = doc as Record<string, any>;
  return { ...fields, id: _id === undefined ? fields.id : getStringIds(_id) } as StoredRecord<T>;
}

function toProjection(select: readonly string[]): string {
  assertSelectFields(select);
  return select.map((field) => (field === 'id' ? '_id' : field)).join(' ');
}
