import { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';

import { getStringIds } from '../helpers/id.helper.js';
import {
  includeTombstones,
  mongoChangeWindowMs,
  mongoServerNow,
  syncOfSchema,
  tombstoneWrite,
} from './mongo/sync-schema.plugin.js';
import type { SyncDescriptor } from './model-descriptor.interface.js';
import {
  assertClientId,
  insertWithServerId,
  suppliedId,
  syncInsertRecord,
  tombstoneClearedFields,
} from './policies/sync.policy.js';
import { SYNC_CLOCK_FIELD, SYNC_DELETED_FIELD } from './sync-model.js';
import {
  assertAccessReason,
  assertArrayField,
  assertProjection,
  assertSampleSize,
  assertSelectFields,
} from './store-guards.js';
import type {
  ChangeClock,
  DataStore,
  DataStoreUpdate,
  DeleteOptions,
  FindOptions,
  PushOptions,
  ReadOptions,
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
  readonly capabilities: Readonly<StoreCapabilities>;
  readonly driver = 'mongodb';
  protected readonly logger = new Logger(MongooseDataStore.name);
  /** The model's sync declaration (`@PersistedModel({ sync })`), read from its schema */
  protected readonly sync?: SyncDescriptor;

  constructor(protected readonly model: Model<any>) {
    this.sync = syncOfSchema(model?.schema);
    this.capabilities = this.sync
      ? Object.freeze({ ...MONGOOSE_STORE_CAPABILITIES, changeOrder: 'clock', idType: this.sync.idFormat })
      : MONGOOSE_STORE_CAPABILITIES;
  }

  get modelName(): string {
    return this.model.modelName;
  }

  /** The server clock and the window W of a synchronized model (its change order is the clock, plan §3.4) */
  async changeClock(): Promise<ChangeClock> {
    if (!this.sync) {
      throw new Error(`changeClock(): ${this.modelName} is not a synchronized model (@PersistedModel({ sync }))`);
    }
    const [now, windowMs] = await Promise.all([mongoServerNow(this.model.db), mongoChangeWindowMs(this.model.db)]);
    return { now, windowMs };
  }

  async count(where?: Where<T>, options: ReadOptions = {}): Promise<number> {
    return this.tombstones(this.model.countDocuments(toMongoFilter(where)), options).exec();
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

  async deleteById(id: string, options: DeleteOptions = {}): Promise<null | StoredRecord<T>> {
    if (this.sync && !options.hardDelete) {
      return this.tombstone({ _id: id }, options);
    }
    return toRecord<T>(await this.tombstones(this.model.findByIdAndDelete(id), options).lean().exec());
  }

  async deleteMany(where: Where<T>, options: DeleteOptions = {}): Promise<number> {
    if (this.sync && !options.hardDelete) {
      const query = tombstoneWrite(this.model.updateMany(toMongoFilter(where), this.tombstoneUpdate() as any));
      const result = await this.tombstones(query, options).exec();
      return result.matchedCount;
    }
    const result = await this.tombstones(this.model.deleteMany(toMongoFilter(where)), options).exec();
    return result.deletedCount;
  }

  async deleteOne(where: Where<T>, options: DeleteOptions = {}): Promise<null | StoredRecord<T>> {
    if (this.sync && !options.hardDelete) {
      return this.tombstone(toMongoFilter(where), options);
    }
    return toRecord<T>(
      await this.tombstones(this.model.findOneAndDelete(toMongoFilter(where)), options)
        .lean()
        .exec(),
    );
  }

  async distinct(field: string, where?: Where<T>, options: ReadOptions = {}): Promise<unknown[]> {
    return this.tombstones(this.model.distinct(field, toMongoFilter(where)), options).exec();
  }

  async find(where?: Where<T>, options: FindOptions = {}): Promise<StoredRecord<T>[]> {
    const sample = options.sample === undefined ? undefined : assertSampleSize(options.sample);
    let query = this.tombstones(this.model.find(toMongoFilter(where)), options);
    if (options.select || options.exclude) query = query.select(toProjection(options));
    if (options.sort) query = query.sort(toMongoSort(options.sort));
    if (options.skip !== undefined) query = query.skip(options.skip);
    if (options.limit !== undefined) query = query.limit(options.limit);
    if (options.collation) query = query.collation(options.collation as any);
    const docs = await query.lean().exec();
    const records = (docs as unknown[]).map((doc) => toRecord<T>(doc));
    // Drawn from the page this query returned, like `$sample` after `$limit`. CrudService.findAndCount() on MongoDB
    // keeps its own aggregation; this path serves callers of the port.
    return sample === undefined ? records : randomSample(records, sample);
  }

  async findById(
    id: string,
    options: Pick<FindOptions, 'exclude' | 'includeTombstones' | 'select'> = {},
  ): Promise<null | StoredRecord<T>> {
    let query = this.tombstones(this.model.findById(id), options);
    if (options.select || options.exclude) query = query.select(toProjection(options));
    return toRecord<T>(await query.lean().exec());
  }

  async findOne(where: Where<T>, options: Omit<FindOptions, 'limit' | 'skip'> = {}): Promise<null | StoredRecord<T>> {
    let query = this.tombstones(this.model.findOne(toMongoFilter(where)), options);
    if (options.select || options.exclude) query = query.select(toProjection(options));
    if (options.sort) query = query.sort(toMongoSort(options.sort));
    if (options.collation) query = query.collation(options.collation as any);
    return toRecord<T>(await query.lean().exec());
  }

  async insert(record: Partial<T>): Promise<StoredRecord<T>> {
    if (this.sync) {
      return this.insertSynchronized(record as Record<string, any>);
    }
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
    const query = this.model.findByIdAndUpdate(id, update as any, {
      returnDocument: 'after',
      ...(options.timestamps === false ? { timestamps: false } : {}),
    });
    return toRecord<T>(await this.tombstones(query, options).lean().exec());
  }

  async updateMany(where: Where<T>, update: DataStoreUpdate<T>, options: UpdateOptions = {}): Promise<number> {
    const query = this.model.updateMany(
      toMongoFilter(where),
      update as any,
      options.timestamps === false ? { timestamps: false } : {},
    );
    const result = await this.tombstones(query, options).exec();
    return result.matchedCount;
  }

  async updateOne(
    where: Where<T>,
    update: DataStoreUpdate<T>,
    options: UpdateOptions = {},
  ): Promise<null | StoredRecord<T>> {
    const query = this.model.findOneAndUpdate(toMongoFilter(where), update as any, {
      returnDocument: 'after',
      ...(options.timestamps === false ? { timestamps: false } : {}),
    });
    return toRecord<T>(await this.tombstones(query, options).lean().exec());
  }

  // -- synchronized models ------------------------------------------------------------------------------------

  /** A query that also sees tombstones when the caller asked for them (synchronized models only) */
  protected tombstones<Q extends object>(query: Q, options: { includeTombstones?: boolean }): Q {
    return this.sync && options.includeTombstones ? includeTombstones(query) : query;
  }

  /**
   * The insert of a synchronized model: system fields set by the store, a client id in the model's format kept, a
   * server id generated anew when it is taken (plan §3.3, E6). `create()` runs every save hook, as for any model.
   */
  protected async insertSynchronized(record: Record<string, any>): Promise<StoredRecord<T>> {
    const { _id: _ignored, id: _alsoIgnored, ...doc } = syncInsertRecord(record);
    const supplied = suppliedId(record);
    if (supplied !== undefined && supplied !== null) {
      const created = await this.model.create({
        ...doc,
        _id: assertClientId(supplied, this.sync.idFormat, this.modelName),
      });
      return toRecord<T>(created.toObject());
    }
    const created = await insertWithServerId(
      this.sync.idFormat,
      (id) => this.model.create({ ...doc, _id: id }),
      (error) => isDuplicateIdError(error),
    );
    return toRecord<T>(created.toObject());
  }

  /** The update that turns a record into a tombstone: content cleared, `deletedAt` from the server clock */
  protected tombstoneUpdate(): Record<string, unknown> {
    const fields = Object.keys(this.model.schema.paths).map((path) => path.split('.', 1)[0]);
    const cleared = tombstoneClearedFields(new Set(fields), this.sync);
    return {
      $currentDate: { [SYNC_CLOCK_FIELD]: true, [SYNC_DELETED_FIELD]: true },
      ...(cleared.length ? { $unset: Object.fromEntries(cleared.map((field) => [field, 1])) } : {}),
    };
  }

  /** Turn the first record matching `filter` into a tombstone; returns it as it was before */
  protected async tombstone(filter: Record<string, any>, options: DeleteOptions): Promise<null | StoredRecord<T>> {
    const query = tombstoneWrite(
      this.model.findOneAndUpdate(filter, this.tombstoneUpdate() as any, { returnDocument: 'before' }),
    );
    return toRecord<T>(await this.tombstones(query, options).lean().exec());
  }
}

/** A duplicate-key error raised by the `_id` index — the case a server-generated id is replaced for */
export function isDuplicateIdError(error: unknown): boolean {
  const candidate = error as { code?: unknown; keyPattern?: Record<string, unknown>; message?: unknown };
  if (candidate?.code !== 11000) {
    return false;
  }
  if (candidate.keyPattern) {
    return Object.keys(candidate.keyPattern).length === 1 && '_id' in candidate.keyPattern;
  }
  return typeof candidate.message === 'string' && /index: _id_ /.test(candidate.message);
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

/** The neutral `id` is `_id` in a sort too */
function toMongoSort(sort: Record<string, -1 | 1>): Record<string, -1 | 1> {
  return Object.fromEntries(
    Object.entries(sort).map(([field, direction]) => [field === 'id' ? '_id' : field, direction]),
  );
}

/** A lean document as a neutral record: the id as a string under `id`, no `_id`, no version key. */
function toRecord<T>(doc: unknown): StoredRecord<T> {
  if (!doc) {
    return null;
  }
  const { __v: _version, _id, ...fields } = doc as Record<string, any>;
  return { ...fields, id: _id === undefined ? fields.id : storedIdString(_id) } as StoredRecord<T>;
}

/** An id as the neutral string: a BSON UUID (a uuidv7 model's id) in its hyphenated form, anything else as before */
function storedIdString(id: unknown): string {
  if (id && typeof id === 'object' && (id as { sub_type?: unknown }).sub_type === 4) {
    return String(id);
  }
  return getStringIds(id);
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
