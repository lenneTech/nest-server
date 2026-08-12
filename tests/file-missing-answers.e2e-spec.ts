import { NotFoundException } from '@nestjs/common';
import { rm } from 'fs/promises';
import mongoose, { Connection, Types } from 'mongoose';
import { tmpdir } from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreFileService } from '../src/core/modules/file/core-file.service';
import { FILESYSTEM_FILES_COLLECTION } from '../src/core/modules/file/filesystem-file.helper';

/**
 * How the service answers for a file that is NOT there — by id and by name.
 *
 * Two asymmetries of this exact shape already shipped (`getRawFileInfoByName()`
 * consulting two stores instead of three in 11.33.0, `deleteFileByName()`
 * dropping `serviceOptions` in 11.33.1), so the by-id and by-name halves are
 * pinned against each other rather than each against itself.
 *
 * The one this file was written for: `deleteFileByName()` answered a clean
 * `NotFoundException` for an unknown name, while `deleteFile()` fell through to
 * the GridFS driver and surfaced `MongoRuntimeError: File not found for id …` —
 * a 500 for the same condition.
 *
 * Only two drivers are exercised. That is not a gap: the S3 branch is skipped by
 * the very same "no metadata row" condition as the filesystem branch, so all
 * three end up in the identical terminal GridFS branch for a file that does not
 * exist anywhere. What differs between drivers is where an EXISTING file is
 * found, which `file-storage-driver` / `file-storage-s3` / `file-duplicate` cover.
 *
 * @regression   11.33.1 — deleteFile() surfaced the GridFS driver's MongoRuntimeError as a 500 for
 *   an unknown id, while deleteFileByName() answered a clean 404 for the same condition; and
 *   duplicateById() answered a TypeError instead of refusing.
 * @seen-failing Registered as mutations `delete-by-id-500-instead-of-404` and
 *   `duplicate-by-id-null-deref` in tests/regression-mutations.json.
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

/**
 * Assert the exception TYPE, not just its text.
 *
 * A message match alone made this file pass without the fix: the MongoDB driver's
 * own `MongoRuntimeError` reads "File not found for id …", which satisfies
 * `/File not found/` while still being an HTTP **500**. The status is the whole
 * point of the assertion, so the status is what gets asserted.
 */
const expectNotFound = async (promise: Promise<unknown>): Promise<void> => {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error, 'expected the call to reject').not.toBeNull();
  expect(error).toBeInstanceOf(NotFoundException);
  expect((error as NotFoundException).getStatus()).toBe(404);
};

function describeMissing(driver: string, fileConfig: Record<string, any>, cleanUp?: () => Promise<void>) {
  describe(`Answers for a missing file — ${driver} driver`, () => {
    let connection: Connection;
    let service: TestFileService;
    let previousConfig: Partial<IServerOptions>;
    const testId = `missing-${driver}-${Date.now()}-p${process.pid}`;
    const unknownId = new Types.ObjectId().toHexString();
    const unknownName = `${testId}-does-not-exist.txt`;

    beforeAll(async () => {
      previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions>;
      ConfigService.setConfig({ ...(previousConfig as any), file: fileConfig } as IServerOptions, { reInit: true });
      connection = mongoose.createConnection(envConfig.mongoose.uri);
      await connection.asPromise();
      service = new TestFileService(connection);
    }, 60_000);

    afterAll(async () => {
      const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'fs' });
      for (const doc of await connection.db.collection('fs.files').find({ filename: { $regex: testId } }).toArray()) {
        await bucket.delete(doc._id).catch(() => undefined);
      }
      await connection.db.collection(FILESYSTEM_FILES_COLLECTION).deleteMany({ filename: { $regex: testId } });
      await connection?.close();
      await cleanUp?.();
      ConfigService.setConfig(previousConfig as IServerOptions, { reInit: true });
    }, 60_000);

    it('answers null from both lookups', async () => {
      expect(await service.getFileInfo(unknownId)).toBeNull();
      expect(await service.getFileInfoByName(unknownName)).toBeNull();
      expect(await service.resolveFile(unknownId)).toBeNull();
    });

    it('reports a missing file the same way whether it is addressed by id or by name', async () => {
      // Was: NotFoundException by name, MongoRuntimeError ("File not found for id …",
      // i.e. an HTTP 500) by id.
      await expectNotFound(service.deleteFile(unknownId));
      await expectNotFound(service.deleteFileByName(unknownName));
    });

    it('refuses to duplicate a missing file the same way by id and by name', async () => {
      await expectNotFound(service.duplicateById(unknownId));
      await expectNotFound(service.duplicateByName(unknownName, `${testId}-copy.txt`));
    });

    it('still deletes a file that IS there, and refuses the second attempt', async () => {
      // Keeps the case above from passing because delete is broken outright.
      const info = await service.createFile(upload('present', `${testId}-present.txt`));

      expect((await service.deleteFile(info.id)).id).toBe(info.id);
      await expectNotFound(service.deleteFile(info.id));
    });
  });
}

describeMissing('gridfs', { storage: 'gridfs' });

const filesystemDir = path.join(tmpdir(), `nest-server-missing-${Date.now()}-p${process.pid}`);
describeMissing('filesystem', { storage: 'filesystem', storageDir: filesystemDir }, () =>
  rm(filesystemDir, { force: true, recursive: true }),
);
