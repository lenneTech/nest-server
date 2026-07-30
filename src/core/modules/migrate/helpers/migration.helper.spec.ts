import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { assertGridFsFileComplete } from './migration.helper';

/**
 * Minimal stand-in for the two collections the check reads.
 *
 * A real Mongo instance is not needed to pin this contract — what matters is
 * the decision the function makes given a files document and a chunk count.
 * The stub records what it was asked for, so a hardcoded bucket name or a wrong
 * filter key cannot slip past unnoticed; the real-MongoDB counterpart lives in
 * `tests/migrate/upload-file-to-gridfs.e2e-spec.ts`.
 */
function dbStub(files: null | Record<string, unknown>, chunkCount: number) {
  const asked: { filters: unknown[]; names: string[] } = { filters: [], names: [] };

  const db = {
    collection: (name: string) => {
      asked.names.push(name);
      if (name.endsWith('.files')) {
        return {
          findOne: async (filter: unknown) => {
            asked.filters.push(filter);
            return files;
          },
        };
      }
      return {
        countDocuments: async (filter: unknown) => {
          asked.filters.push(filter);
          return chunkCount;
        },
      };
    },
  } as unknown as Db;

  return { asked, db };
}

describe('assertGridFsFileComplete', () => {
  const id = new ObjectId();

  it('passes when every chunk is stored', async () => {
    // 700 KiB at the default 255 KiB chunk size = 3 chunks.
    const { db } = dbStub({ _id: id, chunkSize: 261120, length: 716800 }, 3);
    await expect(assertGridFsFileComplete(db, 'fs', id, 'layout.jpg')).resolves.toBeUndefined();
  });

  it('rejects when the record promises more bytes than exist', async () => {
    // The nasty case: the files document looks perfectly healthy, so every
    // listing and every metadata check says the file is fine — only the
    // download fails. Reporting this at upload time is what keeps a broken
    // asset from being persisted as if it were good.
    const { db } = dbStub({ _id: id, chunkSize: 261120, length: 716800 }, 1);
    await expect(assertGridFsFileComplete(db, 'fs', id, 'layout.jpg')).rejects.toThrow(/incomplete: 1 of 3 chunks/);
  });

  it('rejects when the file document is missing entirely', async () => {
    const { db } = dbStub(null, 0);
    await expect(assertGridFsFileComplete(db, 'fs', id, 'layout.jpg')).rejects.toThrow(/no file document/);
  });

  it('accepts an empty file, which GridFS stores with no chunks at all', async () => {
    // GridFS does NOT write a placeholder chunk for a zero-byte file: the
    // driver's `writeRemnant()` returns early on `pos === 0`. A `Math.max(1, …)`
    // floor in the expectation would therefore reject every legitimately empty
    // asset — and since the container entrypoint defaults to
    // `MIGRATE_FAILURE_POLICY=abort`, that would keep the server from starting.
    const { db } = dbStub({ _id: id, chunkSize: 261120, length: 0 }, 0);
    await expect(assertGridFsFileComplete(db, 'fs', id, 'empty.bin')).resolves.toBeUndefined();
  });

  it('reads the bucket it was given, filtered by the file id', async () => {
    // Guards the two things the assertions above cannot see: that the bucket
    // name is not hardcoded, and that the chunk lookup uses `files_id` (a wrong
    // key would count zero and turn every upload into a false failure).
    const { asked, db } = dbStub({ _id: id, chunkSize: 261120, length: 261120 }, 1);
    await assertGridFsFileComplete(db, 'images', id, 'logo.png');

    expect(asked.names).toEqual(['images.files', 'images.chunks']);
    expect(asked.filters).toEqual([{ _id: id }, { files_id: id }]);
  });
});
