import type { Connection } from 'mongoose';

import { isObjectIdLike } from '../../common/helpers/id.helper.js';
import type { DataStore, FindOptions } from '../../common/persistence/data-store.interface.js';
import { getRegisteredDataStore, getStoreForModel } from '../../common/persistence/persistence-runtime.registry.js';
import { UnsupportedCapabilityError } from '../../common/persistence/unsupported-capability.error.js';
import type { FileCollection } from './file-metadata.helper.js';
import { FILESYSTEM_FILE_MODEL, S3_FILE_MODEL } from './file-metadata.models.js';
import { FILESYSTEM_FILES_COLLECTION } from './filesystem-file.helper.js';
import { S3_FILES_COLLECTION } from './s3-file.helper.js';
import { newObjectId } from '../../common/persistence/mongo/mongoose-compat.js';

/** The two stores that keep their metadata outside GridFS */
export type FileMetadataStore = 'filesystem' | 's3';

const STORES: Record<FileMetadataStore, { collection: string; model: string }> = {
  filesystem: { collection: FILESYSTEM_FILES_COLLECTION, model: FILESYSTEM_FILE_MODEL },
  s3: { collection: S3_FILES_COLLECTION, model: S3_FILE_MODEL },
};

/**
 * Where the metadata of a store lives: its MongoDB collection, or — when `database` routes the model to a SQL source —
 * that model's table, behind the same few collection operations the file helpers use. Resolved per call, so a
 * service constructed before the stores exist still reaches the right one.
 *
 * Every reader and writer of `s3-files` / `filesystem-files` goes through here (`CoreFileService`, the TUS hand-off,
 * the Hub): one of them reading the collection while the others write the table would lose files from view.
 */
export function fileMetadataCollection(connection: Connection | null, store: FileMetadataStore): FileCollection {
  const { collection, model } = STORES[store];
  const dataStore = connection
    ? connection.models?.[model]
      ? getStoreForModel(connection.models[model])
      : undefined
    : // No MongoDB connection (PostgreSQL alone, or `database: false`): the store registered for the model is the only
      // one there is — this application's, since no other can have one without a connection either
      getRegisteredDataStore(model);
  if (dataStore && !dataStore.capabilities.mongoosePopulate) {
    return sqlFileCollection(dataStore, collection);
  }
  if (!connection) {
    throw new UnsupportedCapabilityError(
      `The ${collection} file metadata has nowhere to go: no MongoDB is configured and no data source routes ${model}`,
    );
  }
  return connection.db.collection(collection);
}

/**
 * A metadata table seen as the collection the helpers expect: `_id` (an ObjectId) is the record's `id`, MongoDB
 * filters and sorts are passed to the store with `_id` renamed, and a record comes back with `_id` as an ObjectId and
 * without the columns it has no value in — the shape a document of the collection has.
 */
export function sqlFileCollection(store: DataStore<any>, collectionName: string): FileCollection {
  const find = async (filter: unknown, options: Record<string, any> = {}) =>
    (await store.find(toWhere(filter ?? {}), toFindOptions(options))).map(toDocument);
  const collection = {
    collectionName,
    countDocuments: async (filter: unknown = {}) => store.count(toWhere(filter)),
    // The table carries the `filename` index the model declares
    createIndex: async () => 'filename_1',
    dbName: 'sql',
    deleteOne: async (filter: unknown) => ({
      acknowledged: true,
      deletedCount: (await store.deleteOne(toWhere(filter))) ? 1 : 0,
    }),
    find: (filter?: unknown, options?: Record<string, any>) => ({ toArray: () => find(filter, options) }),
    findOne: async (filter?: unknown, options?: Record<string, any>) =>
      (await find(filter, { ...options, limit: 1 }))[0] ?? null,
    insertOne: async (doc: Record<string, any>) => {
      const { _id, ...fields } = doc;
      await store.insert({ ...fields, id: String(_id) });
      return { acknowledged: true, insertedId: _id };
    },
  };
  return collection as unknown as FileCollection;
}

/** A MongoDB filter for the store: `_id` becomes `id`, ObjectIds become their hex strings — at every depth */
function toWhere(value: unknown): any {
  if (isObjectIdLike(value)) {
    return value.toHexString();
  }
  if (Array.isArray(value)) {
    return value.map(toWhere);
  }
  if (!value || typeof value !== 'object' || value instanceof Date || value instanceof RegExp) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key === '_id' ? 'id' : key, toWhere(entry)]));
}

function toFindOptions(options: Record<string, any>): FindOptions {
  const { collation, limit, skip, sort } = options;
  return {
    ...(collation ? { collation } : {}),
    ...(limit ? { limit } : {}),
    ...(skip ? { skip } : {}),
    ...(sort ? { sort: toWhere(sort) } : {}),
  };
}

function toDocument(record: Record<string, any>): Record<string, any> {
  const { id, ...fields } = record;
  return {
    _id: newObjectId(id),
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined)),
  };
}
