import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { MongoClient } from 'mongodb';
import { Types } from 'mongoose';
import { tmpdir } from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import envConfig from '../src/config.env';
import { FILESYSTEM_FILES_COLLECTION, FilesystemFileHelper } from '../src/core/modules/file/filesystem-file.helper';
import { deriveTestDbUri } from './db-lifecycle.reporter';

/**
 * Exercises the `'filesystem'` storage driver end to end against a real MongoDB.
 *
 * The split it has to get right: BYTES on disk, BOOKKEEPING in the database.
 * Filename, content type, length and the custom `metadata` a per-file
 * authorization rule reads all have to stay queryable — a directory listing
 * answers none of that.
 */
describe('Filesystem storage (e2e)', () => {
  let client: MongoClient;
  let directory: string;
  let collection: any;

  const written: Types.ObjectId[] = [];

  beforeAll(async () => {
    client = await MongoClient.connect(envConfig.mongoose.uri);
    collection = client.db().collection(FILESYSTEM_FILES_COLLECTION);
    directory = await mkdtemp(path.join(tmpdir(), 'nest-server-fs-storage-'));
  });

  afterAll(async () => {
    if (written.length) {
      await collection.deleteMany({ _id: { $in: written } });
    }
    await rm(directory, { force: true, recursive: true });
    await client?.close();
  });

  const write = async (options: Parameters<typeof FilesystemFileHelper.writeFile>[2]) => {
    const info = await FilesystemFileHelper.writeFile(directory, collection, options);
    written.push(info._id);
    return info;
  };

  it('records which store holds the bytes, so a reader need not probe all three', async () => {
    const info = await write({ buffer: Buffer.from('marked'), filename: 'marked.txt' });

    // The three stores write structurally identical metadata documents. Without this
    // marker nothing in a fetched file info says where it came from, which is why a
    // single download used to resolve the same id up to three times.
    const stored = await collection.findOne({ _id: info._id });
    expect(stored.storage).toBe('filesystem');
  });

  it('creates the filename index when writing, not when reading', async () => {
    // Runs against its OWN database. The interesting half of this test is an
    // ABSENCE — that a store nobody wrote to never materialises — and an absence
    // is only meaningful in a database no other suite can write to. Asserting it
    // against the shared run database passed locally and failed in CI, where a
    // sibling S3 suite had legitimately created `s3-files` first. The failure was
    // the test's scope, not the code's behaviour.
    const isolated = await MongoClient.connect(deriveTestDbUri('fs-index'));
    try {
      const isolatedCollection = isolated.db().collection(FILESYSTEM_FILES_COLLECTION);
      await FilesystemFileHelper.writeFile(directory, isolatedCollection, {
        buffer: Buffer.from('indexed'),
        filename: 'indexed.txt',
      });

      const names = (await isolatedCollection.indexes()).map((index: any) => index.name);
      expect(names).toContain('filename_1');

      // `createIndex` CREATES the collection, so ensuring an index while READING gave
      // a GridFS-only deployment an empty `s3-files` and `filesystem-files` it has no
      // reason to have. A store that is never written to must stay absent.
      const listed = async (name: string) =>
        (await isolated.db().listCollections({ name }, { nameOnly: true }).toArray()).length;

      // The positive half keeps this from passing vacuously: listCollections must be
      // able to SEE the collection we did write to, or the absence below proves nothing.
      expect(await listed(FILESYSTEM_FILES_COLLECTION)).toBe(1);
      expect(await listed('s3-files')).toBe(0);
    } finally {
      await isolated.db().dropDatabase();
      await isolated.close();
    }
  });

  it('stores the bytes on disk and the metadata in the database', async () => {
    const info = await write({
      buffer: Buffer.from('hello filesystem'),
      contentType: 'text/plain',
      filename: 'fs-basic.txt',
      metadata: { ownerId: 'user-1' },
    });

    // Bytes: on disk, named by id — never by the client-supplied filename.
    const onDisk = FilesystemFileHelper.filePath(directory, info._id);
    expect(existsSync(onDisk)).toBe(true);
    expect(path.basename(onDisk)).toBe(info._id.toHexString());

    // Bookkeeping: queryable, including the custom metadata a rule reads.
    const doc = await collection.findOne({ _id: info._id });
    expect(doc.filename).toBe('fs-basic.txt');
    expect(doc.contentType).toBe('text/plain');
    expect(doc.length).toBe('hello filesystem'.length);
    expect(doc.metadata?.ownerId).toBe('user-1');
    expect(doc.uploadDate).toBeInstanceOf(Date);
  });

  it('round-trips content through stream and buffer', async () => {
    const content = 'streamed content';
    const info = await write({ body: Readable.from([content]), filename: 'fs-stream.txt' });

    expect((await FilesystemFileHelper.getBuffer(directory, info._id)).toString()).toBe(content);

    const chunks: Buffer[] = [];
    for await (const chunk of FilesystemFileHelper.getStream(directory, info._id)) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe(content);
    expect(info.length).toBe(content.length);
  });

  it('finds files by id and by name', async () => {
    const info = await write({ buffer: Buffer.from('x'), filename: 'fs-findable.txt' });

    expect((await FilesystemFileHelper.findFileById(collection, info._id))?.filename).toBe('fs-findable.txt');
    expect((await FilesystemFileHelper.findFileById(collection, info._id.toHexString()))?.filename).toBe(
      'fs-findable.txt',
    );
    expect((await FilesystemFileHelper.findFileByName(collection, 'fs-findable.txt'))?._id.toString()).toBe(
      info._id.toString(),
    );
    expect(await FilesystemFileHelper.findFileById(collection, new Types.ObjectId())).toBeNull();
  });

  it('deletes both the bytes and the metadata', async () => {
    const info = await write({ buffer: Buffer.from('to be deleted'), filename: 'fs-delete.txt' });
    const onDisk = FilesystemFileHelper.filePath(directory, info._id);
    expect(existsSync(onDisk)).toBe(true);

    await FilesystemFileHelper.deleteFile(directory, collection, info._id);

    expect(existsSync(onDisk)).toBe(false);
    expect(await FilesystemFileHelper.findFileById(collection, info._id)).toBeNull();
  });

  it('leaves no metadata row behind when the write fails', async () => {
    // A metadata row whose bytes never arrived is the failure mode that turns a
    // failed upload into a permanent 404 for a file the API insists exists.
    const before = await collection.countDocuments();
    const exploding = new Readable({
      read() {
        this.destroy(new Error('stream exploded'));
      },
    });

    await expect(write({ body: exploding, filename: 'fs-failed.txt' })).rejects.toThrow();
    expect(await collection.countDocuments()).toBe(before);
  });

  it('cannot be steered outside its directory by the id', async () => {
    // The id is an ObjectId, so its hex form carries no separator and no `..`.
    // This pins that the path is built from the id and stays inside the base dir.
    const id = new Types.ObjectId();
    const resolved = FilesystemFileHelper.filePath(directory, id);
    expect(resolved.startsWith(path.resolve(directory) + path.sep)).toBe(true);
    expect(resolved).not.toContain('..');
  });

  it('creates the directory on first write', async () => {
    const nested = path.join(directory, 'deeper', 'still');
    expect(existsSync(nested)).toBe(false);

    const info = await FilesystemFileHelper.writeFile(nested, collection, {
      buffer: Buffer.from('nested'),
      filename: 'fs-nested.txt',
    });
    written.push(info._id);

    expect(existsSync(FilesystemFileHelper.filePath(nested, info._id))).toBe(true);
  });
});
