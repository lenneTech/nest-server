import { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';

import { getStringIds } from '../helpers/id.helper.js';
import {
  assertAccessReason,
  assertArrayField,
  assertProjection,
  assertSampleSize,
  assertSelectFields,
} from './store-guards.js';
import type {
  DataStore,
  DataStoreUpdate,
  FindOptions,
  PushOptions,
  StoreCapabilities,
  StoredRecord,
  UpdateOptions,
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

  async sum(field: string, where?: Where<T>): Promise<{ count: number; sum: number }> {
    assertSelectFields([field]);
    // An aggregation's $match is not cast like a query: cast it through a query of the model first
    const match = this.model.find().cast(this.model, toMongoFilter(where));
    const [row] = await this.model
      .aggregate<{ count: number; sum: number }>([
        { $match: match },
        { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: { $ifNull: [`$${field}`, 0] } } } },
      ])
      .exec();
    return { count: row?.count ?? 0, sum: row?.sum ?? 0 };
  }

  async deleteById(id: string): Promise<null | StoredRecord<T>> {
    return toRecord<T>(await this.model.findByIdAndDelete(id).lean().exec());
  }

  async deleteMany(where: Where<T>): Promise<number> {
    const result = await this.model.deleteMany(toMongoFilter(where)).exec();
    return result.deletedCount;
  }

  async deleteOne(where: Where<T>): Promise<null | StoredRecord<T>> {
    return toRecord<T>(await this.model.findOneAndDelete(toMongoFilter(where)).lean().exec());
  }

  async distinct(field: string, where?: Where<T>): Promise<unknown[]> {
    return this.model.distinct(field, toMongoFilter(where)).exec();
  }

  async find(where?: Where<T>, options: FindOptions = {}): Promise<StoredRecord<T>[]> {
    const sample = options.sample === undefined ? undefined : assertSampleSize(options.sample);
    let query = this.model.find(toMongoFilter(where));
    if (options.select || options.exclude) query = query.select(toProjection(options));
    if (options.sort) query = query.sort(options.sort);
    if (options.skip !== undefined) query = query.skip(options.skip);
    if (options.limit !== undefined) query = query.limit(options.limit);
    if (options.collation) query = query.collation(options.collation as any);
    const docs = await query.lean().exec();
    const records = (docs as unknown[]).map((doc) => toRecord<T>(doc));
    // Drawn from the page this query returned, like `$sample` after `$limit`. CrudService.findAndCount() on MongoDB
    // keeps its own aggregation; this path serves callers of the port.
    return sample === undefined ? records : randomSample(records, sample);
  }

  async findById(id: string, options: Pick<FindOptions, 'exclude' | 'select'> = {}): Promise<null | StoredRecord<T>> {
    let query = this.model.findById(id);
    if (options.select || options.exclude) query = query.select(toProjection(options));
    return toRecord<T>(await query.lean().exec());
  }

  async findOne(where: Where<T>, options: Omit<FindOptions, 'limit' | 'skip'> = {}): Promise<null | StoredRecord<T>> {
    let query = this.model.findOne(toMongoFilter(where));
    if (options.select || options.exclude) query = query.select(toProjection(options));
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

  async updateById(
    id: string,
    update: DataStoreUpdate<T>,
    options: UpdateOptions = {},
  ): Promise<null | StoredRecord<T>> {
    const updated = await this.model
      .findByIdAndUpdate(id, update as any, {
        returnDocument: 'after',
        ...(options.timestamps === false ? { timestamps: false } : {}),
      })
      .lean()
      .exec();
    return toRecord<T>(updated);
  }

  async updateMany(where: Where<T>, update: DataStoreUpdate<T>): Promise<number> {
    const result = await this.model.updateMany(toMongoFilter(where), update as any).exec();
    return result.matchedCount;
  }

  async updateOne(where: Where<T>, update: DataStoreUpdate<T>): Promise<null | StoredRecord<T>> {
    const updated = await this.model
      .findOneAndUpdate(toMongoFilter(where), update as any, { returnDocument: 'after' })
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

function toProjection(options: Pick<FindOptions, 'exclude' | 'select'>): string {
  assertProjection(options);
  if (options.exclude?.length) {
    return options.exclude.map((field) => `-${field}`).join(' ');
  }
  return (options.select ?? []).map((field) => (field === 'id' ? '_id' : field)).join(' ');
}

/** `size` items of `items` in random order (a partial Fisher–Yates shuffle) */
function randomSample<I>(items: I[], size: number): I[] {
  const pool = [...items];
  const count = Math.min(size, pool.length);
  for (let index = 0; index < count; index++) {
    const pick = index + Math.floor(Math.random() * (pool.length - index));
    [pool[index], pool[pick]] = [pool[pick], pool[index]];
  }
  return pool.slice(0, count);
}
