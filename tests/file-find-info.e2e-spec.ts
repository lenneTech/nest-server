import { rm } from 'fs/promises';
import mongoose, { Connection } from 'mongoose';
import { tmpdir } from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { FilterArgs } from '../src/core/common/args/filter.args';
import { ComparisonOperatorEnum } from '../src/core/common/enums/comparison-operator.enum';
import { LogicalOperatorEnum } from '../src/core/common/enums/logical-operator.enum';
import { SortOrderEnum } from '../src/core/common/enums/sort-order.emum';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreFileService } from '../src/core/modules/file/core-file.service';
import { FILESYSTEM_FILES_COLLECTION } from '../src/core/modules/file/filesystem-file.helper';
import { S3_FILES_COLLECTION } from '../src/core/modules/file/s3-file.helper';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * `findFileInfo()` over MORE THAN ONE store, plus the invariant that a store
 * nobody writes to never materialises.
 *
 * The multi-store read path is the part of "switching drivers is forward-only"
 * that is easiest to get subtly wrong: each store answers its own correctly
 * ordered page, and the merge then has to re-establish a GLOBAL order before it
 * pages. Get that wrong and the caller does not merely see the right rows in the
 * wrong order — `skip`/`limit` over a wrongly-ordered merge returns the WRONG
 * ROWS.
 *
 * @regression   11.33.1 — sortMergedFileInfo() ignored DOTTED sort paths, so a merged multi-store
 *   page came back grouped by store and paging over it returned the wrong ROWS; and a filter on
 *   `contentType` matched no GridFS file at all, because GridFS keeps it inside `metadata`.
 * @seen-failing Registered as mutations `merged-sort-ignores-dotted-path` and
 *   `gridfs-content-type-not-mapped` in tests/regression-mutations.json.
 */
class TestFileService extends CoreFileService {
  constructor(connection: Connection) {
    super(connection, 'fs');
  }
}

const upload = (content: string, filename: string) => ({
  createReadStream: () => Readable.from([content]),
  filename,
  mimetype: 'text/plain',
});

const writeGridFs = (connection: Connection, filename: string, metadata?: Record<string, any>) =>
  new Promise<any>((resolve, reject) => {
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    const stream = bucket.openUploadStream(filename, metadata ? { metadata } : undefined);
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id));
    Readable.from(['gridfs side']).pipe(stream);
  });

const args = (overrides: Record<string, any>, marker: string): FilterArgs =>
  ({
    filter: {
      singleFilter: { field: 'filename', operator: ComparisonOperatorEnum.REGEX, value: marker },
    },
    ...overrides,
  }) as unknown as FilterArgs;

describe('findFileInfo across stores (e2e)', () => {
  let connection: Connection;
  let service: TestFileService;
  let directory: string;
  let previousConfig: Partial<IServerOptions>;
  const marker = `findinfo-${Date.now()}-p${process.pid}`;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    directory = path.join(tmpdir(), `nest-server-findinfo-${Date.now()}-p${process.pid}`);
    ConfigService.setConfig(
      { ...(previousConfig as any), file: { storage: 'filesystem', storageDir: directory } } as IServerOptions,
      { reInit: true },
    );

    connection = mongoose.createConnection(envConfig.mongoose.uri);
    await connection.asPromise();
    service = new TestFileService(connection);

    // Interleave the two stores on BOTH sort keys, so a merge that silently keeps
    // the concatenation order (filesystem rows first, then GridFS) is visibly
    // different from a correctly merged one.
    await service.createFile(upload('a', `${marker}-a.txt`), { metadata: { ownerId: 'owner-1' } });
    await writeGridFs(connection, `${marker}-b.txt`, { contentType: 'text/plain', ownerId: 'owner-2' });
    await service.createFile(upload('c', `${marker}-c.txt`), { metadata: { ownerId: 'owner-3' } });
    await writeGridFs(connection, `${marker}-d.txt`, { contentType: 'text/plain', ownerId: 'owner-4' });
  }, 60_000);

  afterAll(async () => {
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    for (const doc of await connection.db.collection('fs.files').find({ filename: { $regex: marker } }).toArray()) {
      await bucket.delete(doc._id).catch(() => undefined);
    }
    await connection.db.collection(FILESYSTEM_FILES_COLLECTION).deleteMany({ filename: { $regex: marker } });
    await connection?.close();
    await rm(directory, { force: true, recursive: true });
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 60_000);

  it('returns the union of both stores exactly once each', async () => {
    const names = (await service.findFileInfo(args({}, marker))).map(file => file.filename);

    expect(names.slice().sort()).toEqual([
      `${marker}-a.txt`,
      `${marker}-b.txt`,
      `${marker}-c.txt`,
      `${marker}-d.txt`,
    ]);
  });

  it('orders a root-field sort globally rather than per store', async () => {
    const sorted = await service.findFileInfo(
      args({ sort: [{ field: 'filename', order: SortOrderEnum.ASC }] }, marker),
    );

    expect(sorted.map(file => file.filename)).toEqual([
      `${marker}-a.txt`,
      `${marker}-b.txt`,
      `${marker}-c.txt`,
      `${marker}-d.txt`,
    ]);
  });

  it('orders a DOTTED sort path globally rather than per store', async () => {
    // `SortInput.field` is a free string and MongoDB reads `metadata.ownerId` as a
    // path, so each store sorted correctly on its own — while the merge compared
    // `doc['metadata.ownerId']`, undefined for every row. Every comparison tied and
    // the page came back grouped by store: a-c-b-d instead of a-b-c-d.
    const sorted = await service.findFileInfo(
      args({ sort: [{ field: 'metadata.ownerId', order: SortOrderEnum.ASC }] }, marker),
    );

    expect(sorted.map(file => file.filename)).toEqual([
      `${marker}-a.txt`,
      `${marker}-b.txt`,
      `${marker}-c.txt`,
      `${marker}-d.txt`,
    ]);
  });

  it('pages a DOTTED sort over the merged result without duplicating or skipping rows', async () => {
    // The consequence of the bug above that actually loses data: a wrongly ordered
    // merge does not just reorder the page, it returns different rows.
    const sort = [{ field: 'metadata.ownerId', order: SortOrderEnum.ASC }];
    const first = await service.findFileInfo(args({ limit: 2, sort }, marker));
    const second = await service.findFileInfo(args({ limit: 2, offset: 2, sort }, marker));

    expect(first.map(file => file.filename)).toEqual([`${marker}-a.txt`, `${marker}-b.txt`]);
    expect(second.map(file => file.filename)).toEqual([`${marker}-c.txt`, `${marker}-d.txt`]);
  });

  it('pages a root-field sort over the merged result without duplicating or skipping rows', async () => {
    const sort = [{ field: 'filename', order: SortOrderEnum.ASC }];
    const pages = [
      await service.findFileInfo(args({ limit: 2, sort }, marker)),
      await service.findFileInfo(args({ limit: 2, offset: 2, sort }, marker)),
    ].map(page => page.map(file => file.filename));

    expect(pages[0]).toEqual([`${marker}-a.txt`, `${marker}-b.txt`]);
    expect(pages[1]).toEqual([`${marker}-c.txt`, `${marker}-d.txt`]);
    expect(new Set([...pages[0], ...pages[1]]).size).toBe(4);
  });

  it('filters on contentType across BOTH stores', async () => {
    // `contentType` was the one field where the drivers were not equivalent:
    // s3-files / filesystem-files carry it at the document root, GridFS keeps it
    // under `metadata`. So this filter matched the filesystem rows and none of the
    // GridFS ones — a listing that silently loses every file written before the
    // driver switch (and returns nothing at all on the GridFS driver itself).
    const typed = await service.findFileInfo(
      args(
        {
          filter: {
            combinedFilter: {
              filters: [
                { singleFilter: { field: 'filename', operator: ComparisonOperatorEnum.REGEX, value: marker } },
                { singleFilter: { field: 'contentType', operator: ComparisonOperatorEnum.EQ, value: 'text/plain' } },
              ],
              logicalOperator: LogicalOperatorEnum.AND,
            },
          },
          sort: [{ field: 'filename', order: SortOrderEnum.ASC }],
        },
        marker,
      ),
    );

    // b and d are the GridFS rows — written with metadata.contentType 'text/plain'.
    expect(typed.map(file => file.filename)).toEqual([
      `${marker}-a.txt`,
      `${marker}-b.txt`,
      `${marker}-c.txt`,
      `${marker}-d.txt`,
    ]);
  });

  it('falls back to newest-first when no sort is given', async () => {
    const names = (await service.findFileInfo(args({}, marker))).map(file => file.filename);

    // Written a → b → c → d, so uploadDate DESC is the reverse.
    expect(names).toEqual([`${marker}-d.txt`, `${marker}-c.txt`, `${marker}-b.txt`, `${marker}-a.txt`]);
  });
});

describe('metadata collections materialise only when written to (e2e)', () => {
  // Its own database: the assertion is an ABSENCE, which is only meaningful where
  // no sibling suite can legitimately create the collection first.
  let connection: Connection;
  let previousConfig: Partial<IServerOptions>;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    ConfigService.setConfig({ ...(previousConfig as any), file: { storage: 'gridfs' } } as IServerOptions, {
      reInit: true,
    });
    connection = mongoose.createConnection(deriveTestDbUri('file-materialise'));
    await connection.asPromise();
  }, 60_000);

  afterAll(async () => {
    await connection?.dropDatabase().catch(() => undefined);
    await connection?.close();
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  }, 60_000);

  it('leaves s3-files and filesystem-files absent on a GridFS-only deployment', async () => {
    const service = new TestFileService(connection);

    // A full round trip through every read path a download uses — each of which
    // consults all three stores.
    const info = await service.createFile(upload('gridfs only', 'materialise.txt'));
    expect(await service.getFileInfo(info.id)).toBeTruthy();
    expect(await service.getFileInfoByName('materialise.txt')).toBeTruthy();
    expect(await service.resolveFile(info.id)).toBeTruthy();
    expect(await service.findFileInfo()).not.toHaveLength(0);
    expect((await service.getBuffer(info.id)).toString()).toBe('gridfs only');

    const listed = async (name: string) =>
      (await connection.db.listCollections({ name }, { nameOnly: true }).toArray()).length;

    // Positive half first, so the absences below cannot pass vacuously.
    expect(await listed('fs.files')).toBe(1);
    expect(await listed(S3_FILES_COLLECTION)).toBe(0);
    expect(await listed(FILESYSTEM_FILES_COLLECTION)).toBe(0);
  });
});
