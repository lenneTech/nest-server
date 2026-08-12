import { Types } from 'mongoose';

import { CoreHubDbService } from '../../src/core/modules/hub/services/core-hub-db.service';
import { HubActionMessage } from '../../src/core/modules/hub/hub-action-messages';
import { HubFilesData } from '../../src/core/modules/hub/interfaces/hub-panels.interface';

/**
 * The Hub Files panel across the three storage drivers.
 *
 * WHY A UNIT TEST WITH A FAKE DB: the defect is a DISPATCH defect — which collections are consulted,
 * and which store a delete is routed to. Reproducing it end-to-end would need three live backends
 * (a bucket, a disk, GridFS) to observe a decision that is fully determined before any of them is
 * touched. The fake below records exactly the thing under test: the set of collections asked, and
 * the store a delete lands in.
 *
 * The e2e coverage that the real backends DO deserve already exists for the service this panel
 * mirrors (`tests/file-storage-parity.e2e-spec.ts`).
 *
 * @regression   11.33.x — the Hub Files panel read `fs.files` alone: 0 files and no delete under
 *               `file.storage: 's3'` / `'filesystem'`; an S3 delete could orphan its object; and the
 *               merged page was never re-sorted, so paging it returned the wrong rows.
 * @seen-failing `pnpm run check:mutations -- --id=hub-files-gridfs-only`,
 *               `--id=hub-s3-delete-orphans-metadata` and `--id=hub-files-merge-not-sorted`
 *               (registered in tests/regression-mutations.json)
 */

/** A metadata document as any of the three stores would hold it. */
interface FakeDoc {
  _id: Types.ObjectId;
  contentType?: string;
  filename: string;
  length: number;
  uploadDate: Date;
}

/** Records every collection touched, so "did it even look?" is directly assertable. */
class FakeDb {
  readonly deletedFrom: { collection: string; id: string }[] = [];
  readonly queried: string[] = [];

  constructor(private readonly data: Record<string, FakeDoc[]>) {}

  collection(name: string) {
    this.queried.push(name);
    const docs = this.data[name] ?? [];
    return {
      countDocuments: async () => docs.length,
      // `GridFSBucket.delete()` removes the fs.files document and then its fs.chunks rows, so the
      // fake has to answer both — that is the real bucket's contract, not an invention here.
      deleteMany: async () => ({ deletedCount: 1 }),
      deleteOne: async (filter: any) => {
        this.deletedFrom.push({ collection: name, id: String(filter._id) });
        return { deletedCount: 1 };
      },
      find: (filter: any = {}, options: any = {}) => ({
        toArray: async () => {
          let rows = docs;
          if (filter?._id) {
            rows = rows.filter((doc) => String(doc._id) === String(filter._id));
          }
          if (options.sort?.uploadDate === -1) {
            rows = [...rows].sort((a, b) => b.uploadDate.getTime() - a.uploadDate.getTime());
          }
          return options.limit ? rows.slice(0, options.limit) : rows;
        },
      }),
    };
  }
}

const doc = (filename: string, isoDate: string): FakeDoc => ({
  _id: new Types.ObjectId(),
  contentType: 'text/plain',
  filename,
  length: 3,
  uploadDate: new Date(isoDate),
});

const buildService = (db: FakeDb, s3Service?: any) =>
  new CoreHubDbService({ db: {} } as any, { db } as any, s3Service as any);

describe('CoreHubDbService — Files panel across storage drivers', () => {
  // The upload dates deliberately do NOT follow the store probe order (s3 → filesystem → gridfs).
  // That is the whole load-bearing property of this fixture: with dates that happen to descend in
  // probe order, a build that never sorts the merge produces the same page as one that does, and
  // the ordering assertions below pass while checking nothing. That is not hypothetical — the first
  // version of this file had exactly that fixture, and `check:mutations` reported the ordering test
  // VACUOUS against the `hub-files-merge-not-sorted` mutation.
  //
  //   probe order:      s3 (Jan 1) → filesystem (Jan 3) → gridfs (Jan 2)
  //   newest-first:     filesystem (Jan 3) → gridfs (Jan 2) → s3 (Jan 1)
  const gridfsFile = doc('in-gridfs.txt', '2026-01-02T00:00:00.000Z');
  const s3File = doc('in-s3.txt', '2026-01-01T00:00:00.000Z');
  const filesystemFile = doc('in-filesystem.txt', '2026-01-03T00:00:00.000Z');

  const allStores = () =>
    new FakeDb({
      'filesystem-files': [filesystemFile],
      'fs.files': [gridfsFile],
      's3-files': [s3File],
    });

  describe('getFiles', () => {
    it('lists files from ALL THREE stores, not GridFS alone', async () => {
      const db = allStores();
      const result = (await buildService(db).getFiles()) as HubFilesData;

      expect(result.files.map((file) => file.filename).sort()).toEqual([
        'in-filesystem.txt',
        'in-gridfs.txt',
        'in-s3.txt',
      ]);
      expect(result.total).toBe(3);
    });

    it('reports 0 files only when the stores are genuinely empty — the S3-driver regression', async () => {
      // The exact deployment the bug produced a wrong answer for: bytes in S3, nothing in GridFS.
      // Before the fix this returned `{ total: 0, files: [] }`, which an operator reads as "the
      // upload did not land".
      const db = new FakeDb({ 's3-files': [s3File] });
      const result = (await buildService(db).getFiles()) as HubFilesData;

      expect(result.files).toHaveLength(1);
      expect(result.files[0].store).toBe('s3');
      expect(result.total).toBe(1);
    });

    it('tags every row with the store it came from', async () => {
      const result = (await buildService(allStores()).getFiles()) as HubFilesData;
      const byName = Object.fromEntries(result.files.map((file) => [file.filename, file.store]));

      expect(byName).toEqual({
        'in-filesystem.txt': 'filesystem',
        'in-gridfs.txt': 'gridfs',
        'in-s3.txt': 's3',
      });
    });

    it('summarises every store, so an empty one reads as empty rather than as uncovered', async () => {
      const db = new FakeDb({ 'fs.files': [gridfsFile] });
      const result = (await buildService(db).getFiles()) as HubFilesData;

      expect(result.stores.map((entry) => entry.store).sort()).toEqual(['filesystem', 'gridfs', 's3']);
      expect(result.stores.find((entry) => entry.store === 's3')).toMatchObject({ count: 0 });
      expect(result.stores.find((entry) => entry.store === 'gridfs')).toMatchObject({ count: 1 });
    });

    it('sorts the MERGED page newest-first rather than grouping it by store', async () => {
      const result = (await buildService(allStores()).getFiles()) as HubFilesData;

      // Newest-first, which is NOT the store probe order — concatenating per-store pages would have
      // produced `['in-s3.txt', 'in-filesystem.txt', 'in-gridfs.txt']` instead, and `skip`/`limit`
      // over that returns the WRONG ROWS rather than merely a wrong order.
      expect(result.files.map((file) => file.filename)).toEqual([
        'in-filesystem.txt',
        'in-gridfs.txt',
        'in-s3.txt',
      ]);
    });

    it('pages over the merge, not within each store', async () => {
      const result = (await buildService(allStores()).getFiles('fs', 1, 1)) as HubFilesData;

      // Second row of the MERGED order. Under store order it would have been 'in-filesystem.txt'.
      expect(result.files.map((file) => file.filename)).toEqual(['in-gridfs.txt']);
    });

    it('keeps the other stores listed when one cannot be read', async () => {
      const db = allStores();
      const original = db.collection.bind(db);
      db.collection = ((name: string) => {
        if (name === 's3-files') {
          throw new Error('boom');
        }
        return original(name);
      }) as any;

      const result = (await buildService(db).getFiles()) as HubFilesData;

      expect(result.stores.find((entry) => entry.store === 's3')?.error).toBe('boom');
      expect(result.files.map((file) => file.filename).sort()).toEqual(['in-filesystem.txt', 'in-gridfs.txt']);
    });
  });

  describe('deleteFile', () => {
    it('deletes a GridFS file through the bucket', async () => {
      const db = allStores();
      const result = await buildService(db).deleteFile(String(gridfsFile._id), 'in-gridfs.txt');

      expect(result).toMatchObject({ filename: 'in-gridfs.txt', store: 'gridfs' });
    });

    it('deletes a filesystem-backed file — previously impossible from the Hub', async () => {
      const db = allStores();
      const result = await buildService(db).deleteFile(String(filesystemFile._id), 'in-filesystem.txt');

      expect(result).toMatchObject({ filename: 'in-filesystem.txt', store: 'filesystem' });
      expect(db.deletedFrom).toContainEqual({
        collection: 'filesystem-files',
        id: String(filesystemFile._id),
      });
    });

    it('deletes an S3-backed file through CoreS3Service', async () => {
      const deleted: string[] = [];
      const s3Service = { deleteObject: async (key: string) => void deleted.push(key), enabled: true };
      const db = allStores();

      const result = await buildService(db, s3Service).deleteFile(String(s3File._id), 'in-s3.txt');

      expect(result).toMatchObject({ filename: 'in-s3.txt', store: 's3' });
      expect(deleted).toEqual([s3File._id.toHexString()]);
      expect(db.deletedFrom).toContainEqual({ collection: 's3-files', id: String(s3File._id) });
    });

    it('REFUSES an S3 delete when S3 is unavailable, instead of orphaning the object', async () => {
      const db = allStores();

      await expect(buildService(db, { enabled: false }).deleteFile(String(s3File._id), 'in-s3.txt')).rejects.toThrow(
        HubActionMessage.s3Unavailable,
      );
      // The metadata document must survive — a half-delete is the unrecoverable outcome.
      expect(db.deletedFrom).toHaveLength(0);
    });

    it('still enforces the type-to-confirm filename on a non-GridFS store', async () => {
      const db = allStores();

      await expect(buildService(db).deleteFile(String(filesystemFile._id), 'wrong-name.txt')).rejects.toThrow(
        HubActionMessage.confirmationFilenameMismatch,
      );
      expect(db.deletedFrom).toHaveLength(0);
    });

    it('answers "not found" for an id in no store at all', async () => {
      await expect(
        buildService(allStores()).deleteFile(String(new Types.ObjectId()), 'nope.txt'),
      ).rejects.toThrow(HubActionMessage.fileNotFound);
    });

    it('rejects a malformed id before touching any store', async () => {
      const db = allStores();

      await expect(buildService(db).deleteFile('not-an-object-id', 'x')).rejects.toThrow(
        HubActionMessage.invalidFileId,
      );
      expect(db.queried).toHaveLength(0);
    });
  });
});
