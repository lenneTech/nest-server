import { rm } from 'fs/promises';
import mongoose, { Connection } from 'mongoose';
import { tmpdir } from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreFileService } from '../src/core/modules/file/core-file.service';
import { FILESYSTEM_FILES_COLLECTION, FilesystemFileHelper } from '../src/core/modules/file/filesystem-file.helper';

/**
 * Drives `CoreFileService` itself with `file.storage: 'filesystem'`.
 *
 * `filesystem-storage.e2e-spec.ts` covers the helper in isolation; this covers
 * the DISPATCH around it, which is where a third driver actually goes wrong:
 * writes must go to the active store only, reads must consult every store, and
 * delete must find the file wherever it lives. The read-fallback assertion is
 * the load-bearing one — it is what makes "switching drivers is forward-only,
 * no migration" true rather than aspirational.
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

describe('File storage driver dispatch (e2e)', () => {
  let connection: Connection;
  let directory: string;
  let previousConfig: Partial<IServerOptions>;
  const testId = `driver-${Date.now()}`;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
    directory = path.join(tmpdir(), `nest-server-driver-${Date.now()}`);

    ConfigService.setConfig(
      {
        ...(previousConfig as any),
        file: { storage: 'filesystem', storageDir: directory },
      } as IServerOptions,
      { reInit: true },
    );

    connection = mongoose.createConnection(envConfig.mongoose.uri);
    await connection.asPromise();
  });

  afterAll(async () => {
    await connection?.db?.collection(FILESYSTEM_FILES_COLLECTION).deleteMany({ filename: { $regex: testId } });
    await connection?.close();
    await rm(directory, { force: true, recursive: true });
    ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
  });

  it('resolves the configured driver instead of defaulting to GridFS', () => {
    const service = new TestFileService(connection);
    expect(service['storageDriver']).toBe('filesystem');
    expect(service['storageResolution'].explicit).toBe(true);
  });

  it('writes new files to the filesystem, not to GridFS', async () => {
    const service = new TestFileService(connection);
    const filename = `${testId}-written.txt`;

    const info = await service.createFile(upload('written to disk', filename));

    expect(info.id).toBeTruthy();
    // In the filesystem metadata store…
    const fsDoc = await FilesystemFileHelper.findFileById(
      connection.db.collection(FILESYSTEM_FILES_COLLECTION),
      info.id,
    );
    expect(fsDoc?.filename).toBe(filename);
    // …and NOT in GridFS.
    const gridfsDocs = await connection.db.collection('fs.files').find({ filename }).toArray();
    expect(gridfsDocs).toHaveLength(0);
  });

  it('round-trips content through the service', async () => {
    const service = new TestFileService(connection);
    const filename = `${testId}-roundtrip.txt`;
    const content = 'round trip through the service';

    const info = await service.createFile(upload(content, filename));

    expect((await service.getBuffer(info.id)).toString()).toBe(content);
    expect((await service.getFileInfo(info.id)).filename).toBe(filename);
    expect((await service.getFileInfoByName(filename)).id).toBe(info.id);

    const chunks: Buffer[] = [];
    for await (const chunk of await service.getFileStream(info.id)) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe(content);
  });

  it('carries custom metadata through, so a per-file rule has something to read', async () => {
    const service = new TestFileService(connection);
    const filename = `${testId}-owned.txt`;

    const info = await service.createFile(upload('owned', filename), { metadata: { ownerId: 'user-42' } });

    // getRawFileInfo() is the read side of checkRights() — it must find the file
    // under this driver too, or an owner rule silently denies everything.
    const raw = await service['getRawFileInfo'](info.id);
    expect(raw?.metadata?.ownerId).toBe('user-42');
  });

  it('still reads files written under a PREVIOUS driver', async () => {
    // The forward-only promise: a project that switches to 'filesystem' keeps
    // serving everything it wrote to GridFS before, with no migration step.
    const filename = `${testId}-legacy-gridfs.txt`;
    const content = 'stored in gridfs before the switch';

    // Write straight to GridFS, bypassing the (now filesystem) service.
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    const legacyId = await new Promise<any>((resolve, reject) => {
      const stream = bucket.openUploadStream(filename, { metadata: { contentType: 'text/plain' } });
      stream.on('error', reject);
      stream.on('finish', () => resolve(stream.id));
      Readable.from([content]).pipe(stream);
    });

    const service = new TestFileService(connection);
    expect((await service.getFileInfo(legacyId)).filename).toBe(filename);
    expect((await service.getBuffer(legacyId)).toString()).toBe(content);

    await service.deleteFile(legacyId);
    expect(await service.getFileInfo(legacyId)).toBeNull();
  });

  it('deletes from the filesystem store', async () => {
    const service = new TestFileService(connection);
    const filename = `${testId}-deleted.txt`;
    const info = await service.createFile(upload('to be deleted', filename));

    await service.deleteFile(info.id);

    expect(await service.getFileInfo(info.id)).toBeNull();
    expect(
      await FilesystemFileHelper.findFileById(connection.db.collection(FILESYSTEM_FILES_COLLECTION), info.id),
    ).toBeNull();
  });

  it('merges both stores in findFileInfo', async () => {
    // The property under test is that BOTH stores contribute — a single-store
    // read path would silently hide half the files after a driver switch.
    // Asserted by containment rather than by an exact list: the collection is
    // shared with the other cases in this file, and a retry would re-add rows.
    const service = new TestFileService(connection);
    const marker = `${testId}-merged-${Math.random().toString(36).substring(7)}`;

    await service.createFile(upload('fs side', `${marker}-a.txt`));
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
    await new Promise<void>((resolve, reject) => {
      const stream = bucket.openUploadStream(`${marker}-b.txt`);
      stream.on('error', reject);
      stream.on('finish', () => resolve());
      Readable.from(['gridfs side']).pipe(stream);
    });

    const names = (await service.findFileInfo()).map(f => f.filename);
    expect(names).toContain(`${marker}-a.txt`);
    expect(names).toContain(`${marker}-b.txt`);

    // …and each appears exactly once, which is what the merge-then-page logic buys.
    expect(names.filter(n => n === `${marker}-a.txt`)).toHaveLength(1);
    expect(names.filter(n => n === `${marker}-b.txt`)).toHaveLength(1);

    for (const doc of await connection.db.collection('fs.files').find({ filename: { $regex: marker } }).toArray()) {
      await bucket.delete(doc._id);
    }
  });
});
