import { afterEach, describe, expect, it } from 'vitest';

import { registerDataStore } from '../../src/core/common/persistence/persistence-runtime.registry';
import { FILESYSTEM_FILE_MODEL, S3_FILE_MODEL } from '../../src/core/modules/file/file-metadata.models';
import { fileMetadataCollection } from '../../src/core/modules/file/file-metadata.store';

/**
 * Without a MongoDB connection (a project on PostgreSQL alone, 12.1.0+) the file metadata store is found through the
 * store registered for its model — `connection.models` does not exist there.
 */
describe('file metadata without a MongoDB connection', () => {
  afterEach(() => {
    registerDataStore(FILESYSTEM_FILE_MODEL, undefined as any);
    registerDataStore(S3_FILE_MODEL, undefined as any);
  });

  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — fileMetadataCollection() looked the store up through
   *   `connection.models` only, so a project without MongoDB failed every upload with "Cannot read properties of null".
   * @seen-failing Replace the registry fallback in fileMetadataCollection() (src/core/modules/file/file-metadata.store.ts)
   *   with `undefined` — registered as mutation `file-metadata-store-needs-connection` in tests/regression-mutations.json.
   */
  it('reads and writes through the registered store of the model', async () => {
    const records: any[] = [];
    registerDataStore(FILESYSTEM_FILE_MODEL, {
      capabilities: { mongoosePopulate: false },
      find: async () => records,
      insert: async (record: any) => {
        records.push({ ...record, id: 'a'.repeat(24) });
        return records.at(-1);
      },
      modelName: FILESYSTEM_FILE_MODEL,
    } as any);
    const collection = fileMetadataCollection(null, 'filesystem');
    await collection.insertOne({ filename: 'a.txt' } as any);
    expect((await collection.find({}).toArray()).map((doc: any) => doc.filename)).toEqual(['a.txt']);
  });

  it('names the cause when no store holds the metadata', () => {
    expect(() => fileMetadataCollection(null, 's3')).toThrow(/no MongoDB is configured and no data source routes/);
  });
});
