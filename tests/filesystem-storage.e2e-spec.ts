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
