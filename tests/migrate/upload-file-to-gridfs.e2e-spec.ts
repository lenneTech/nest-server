/**
 * E2E tests for `uploadFileToGridFS`.
 *
 * The helper is used by seed migrations to put binary assets (images, PDFs)
 * into GridFS before the server boots. Three of its guarantees are load-bearing
 * and were all missing once:
 *
 * 1. **The bytes are really there when it resolves.** A GridFS upload is N
 *    chunk documents plus one files document. `'finish'` only says the stream
 *    ended. A helper that trusts it can hand back an id that points at an
 *    incomplete file — the caller stores that id, and the defect surfaces much
 *    later as a broken download from a record that looks healthy.
 * 2. **An unreadable source rejects instead of hanging.** `pipe()` does not
 *    forward read-stream errors, so a missing file used to leave the promise
 *    pending forever — a migration that never returns and a container that
 *    never reaches its server.
 * 3. **The connection is closed when it settles.** A leaked client keeps an
 *    SDAM monitor timer alive, which keeps the Node event loop busy: `migrate up`
 *    prints "All migrations completed successfully" and never exits.
 *
 * Guarantee 3 is the one a stub can never show, which is why it is asserted here
 * against a real MongoDB rather than in the unit spec.
 */

import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { GridFSBucket, MongoClient } from 'mongodb';
import { tmpdir } from 'os';
import { join } from 'path';

import { uploadFileToGridFS } from '../../src/core/modules/migrate/helpers/migration.helper';
import { deriveTestDbUri } from '../db-lifecycle.reporter';

describe('uploadFileToGridFS (e2e)', () => {
  // Always derive from the per-run database. An env escape hatch here would only
  // ever be able to point the suite at a NON-test database — nothing in the repo
  // sets one, and `global-setup.ts` guards its own override with a safe-name
  // pattern that this file could not reuse.
  const mongoUrl = deriveTestDbUri('gridfs-upload');
  const bucketName = 'uploadhelper';

  let client: MongoClient | undefined;
  let workDir: string | undefined;

  beforeAll(async () => {
    client = await MongoClient.connect(mongoUrl);
    workDir = mkdtempSync(join(tmpdir(), 'gridfs-upload-'));
  });

  afterAll(async () => {
    // Null-guarded: if beforeAll failed (no mongod), an unguarded teardown throws
    // a TypeError that masks the real cause.
    if (client) {
      for (const name of [`${bucketName}.files`, `${bucketName}.chunks`]) {
        await client
          .db()
          .collection(name)
          .drop()
          .catch(() => undefined);
      }
      await client.close();
    }
    if (workDir) {
      rmSync(workDir, { force: true, recursive: true });
    }
  });

  it('stores every chunk of a multi-chunk file', async () => {
    // Deliberately larger than one 255 KiB chunk: a single-chunk file would
    // pass even if only the first chunk were ever written, which is precisely
    // the failure this helper has to rule out.
    const source = join(workDir!, 'multi-chunk.bin');
    const payload = randomBytes(700 * 1024);
    writeFileSync(source, payload);

    const id = await uploadFileToGridFS(mongoUrl, source, { bucketName });

    const files = await client!.db().collection(`${bucketName}.files`).findOne({ _id: id });
    expect(files).toBeTruthy();
    expect(files!.length).toEqual(payload.length);

    const chunks = await client!.db().collection(`${bucketName}.chunks`).countDocuments({ files_id: id });
    expect(chunks).toEqual(Math.ceil(payload.length / files!.chunkSize));

    // And the bytes read back identical — the count alone would not catch a
    // chunk that was written but truncated.
    const downloaded: Buffer[] = [];
    const bucket = new GridFSBucket(client!.db(), { bucketName });
    await new Promise<void>((resolve, reject) => {
      bucket
        .openDownloadStream(id)
        .on('data', (chunk: Buffer) => downloaded.push(chunk))
        .on('end', resolve)
        .on('error', reject);
    });
    expect(Buffer.concat(downloaded).equals(payload)).toBe(true);
  });

  it('accepts an empty file, which GridFS stores with no chunks at all', async () => {
    // The driver skips the insert entirely for a zero-length buffer
    // (`writeRemnant()` returns early on `pos === 0`), so the completeness check
    // must not demand a minimum of one chunk. It did once — and because the
    // container entrypoint defaults to `MIGRATE_FAILURE_POLICY=abort`, a seed
    // migration carrying an empty placeholder would have blocked the boot.
    const source = join(workDir!, 'empty.bin');
    writeFileSync(source, Buffer.alloc(0));

    const id = await uploadFileToGridFS(mongoUrl, source, { bucketName });

    const files = await client!.db().collection(`${bucketName}.files`).findOne({ _id: id });
    expect(files!.length).toEqual(0);
    await expect(client!.db().collection(`${bucketName}.chunks`).countDocuments({ files_id: id })).resolves.toEqual(0);
  });

  it('resolves a relative path against the helper module, as every documented caller does', async () => {
    // The README, the migration template and the 11.3.x guide all pass a
    // RELATIVE path, which `path.resolve(__dirname, …)` anchors at the helper's
    // own directory. An absolute path silently bypasses that anchoring (resolve
    // discards the base), so only this case exercises the real code path.
    const id = await uploadFileToGridFS(mongoUrl, '../templates/migration-project.template.ts', { bucketName });

    const files = await client!.db().collection(`${bucketName}.files`).findOne({ _id: id });
    expect(files).toBeTruthy();
    expect(files!.filename).toEqual('migration-project.template.ts');
    expect(files!.length).toBeGreaterThan(0);
  });

  it('rejects a source file that cannot be read instead of hanging', async () => {
    // `pipe()` does not forward read-stream errors. Without an explicit handler
    // the write stream never finishes and the promise never settles — the
    // migration simply stops, with no error to point at.
    //
    // Matched on ENOENT rather than a bare `toThrow()`: an unmatched assertion
    // would also pass on a connection failure, i.e. for a reason that has
    // nothing to do with the handler under test.
    await expect(uploadFileToGridFS(mongoUrl, join(workDir!, 'does-not-exist.bin'), { bucketName })).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('closes its connection on both the success and the failure path', async () => {
    // The headline fix: an unclosed client keeps an SDAM monitor timer alive and
    // the CLI never exits. Asserted by handle count rather than by inspecting the
    // private client — N uploads must not leave N connections behind, which is
    // exactly what the leak looked like.
    const source = join(workDir!, 'handles.bin');
    writeFileSync(source, randomBytes(1024));

    // Warm up first: the very first connect lazily creates driver-internal
    // resources that would otherwise be counted as growth.
    await uploadFileToGridFS(mongoUrl, source, { bucketName });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const before = process.getActiveResourcesInfo().length;

    for (let i = 0; i < 3; i++) {
      await uploadFileToGridFS(mongoUrl, source, { bucketName });
    }
    // And a failing upload, which settles through the reject path.
    await expect(uploadFileToGridFS(mongoUrl, join(workDir!, 'nope.bin'), { bucketName })).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = process.getActiveResourcesInfo().length;

    // Four more connections would show up plainly; allow a small margin for
    // unrelated timers rather than demanding an exact match.
    expect(after - before).toBeLessThan(4);
  });
});
