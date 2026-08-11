import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rm, stat } from 'fs/promises';
import { Types } from 'mongoose';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

import {
  ensureFilenameIndex,
  FileCollection,
  FileMetadataInfo,
  findMetadata,
  findMetadataById,
  findMetadataByName,
} from './file-metadata.helper';
import { streamToBuffer } from './s3-file.helper';

/** Metadata collection for files stored on the local filesystem */
export const FILESYSTEM_FILES_COLLECTION = 'filesystem-files';

/** Default directory for the filesystem storage driver */
export const DEFAULT_FILESYSTEM_DIR = 'uploads/files';

/**
 * Metadata of a file stored on the local filesystem.
 *
 * Alias of the shared {@link FileMetadataInfo} — same document as `S3FileInfo` and,
 * in its first six fields, as a GridFS `fs.files` document, which is what lets
 * `prepareOutput()` map all three onto `CoreFileInfo` unchanged.
 */
export type FilesystemFileInfo = FileMetadataInfo;

/**
 * Helper for files stored on the local filesystem with their metadata in MongoDB.
 *
 * Counterpart of `GridFSHelper` and `S3FileHelper`: same operations, the local
 * disk as the byte store and `filesystem-files` as the metadata store.
 *
 * WHY THE METADATA STILL LIVES IN MONGO: filename, content type, length and the
 * custom `metadata` a per-file authorization rule reads have to be queryable —
 * `findFileInfo()` filters and pages over them, and `checkRights()` reads them
 * per request. A directory listing answers none of that, and sidecar files would
 * reinvent an index that the database already is. So this driver moves the
 * BYTES off the database, not the bookkeeping.
 *
 * OPERATIONAL CONSEQUENCE: the directory is pod-local. Two replicas do not share
 * it, and a container restart discards it unless the path is a mounted volume.
 * That makes this the right driver for a single-instance deployment or a real
 * volume, and the wrong one for a horizontally scaled service — use S3 there.
 */
export class FilesystemFileHelper {
  /**
   * Resolve the absolute path of a stored file.
   *
   * The id is an ObjectId, so its hex form cannot contain a path separator or
   * `..` — the join can never escape the base directory. Callers must not pass
   * a user-supplied filename here.
   */
  static filePath(directory: string, id: string | Types.ObjectId): string {
    const objectId = typeof id === 'string' ? new Types.ObjectId(id) : id;
    return path.join(path.resolve(directory), objectId.toHexString());
  }

  /**
   * Store a file on disk and record its metadata.
   *
   * The written size is verified via `stat()` before the metadata document is
   * written, so a file info is never returned for bytes that did not fully
   * arrive — the same guarantee `GridFSHelper` gives by reading the file
   * document back, and `S3FileHelper` by issuing a HEAD.
   *
   * On any failure the partial file is removed before the error propagates,
   * otherwise a failed upload would leave an orphan the metadata never names.
   */
  static async writeFile(
    directory: string,
    collection: FileCollection,
    options: {
      body?: Readable;
      buffer?: Buffer;
      contentType?: string;
      filename: string;
      metadata?: Record<string, any>;
    },
  ): Promise<FilesystemFileInfo> {
    const _id = new Types.ObjectId();
    const target = FilesystemFileHelper.filePath(directory, _id);

    await mkdir(path.dirname(target), { recursive: true });

    try {
      if (options.buffer) {
        await pipeline(Readable.from(options.buffer), createWriteStream(target));
      } else if (options.body) {
        await pipeline(options.body, createWriteStream(target));
      } else {
        throw new Error('FilesystemFileHelper.writeFile requires either `buffer` or `body`');
      }

      const stats = await stat(target);
      if (!stats.size && (options.buffer?.length || 0) > 0) {
        throw new Error(`File ${_id.toHexString()} was written empty`);
      }

      // On the WRITE path, not the read path: createIndex creates the collection, so
      // ensuring it when reading gave a GridFS-only deployment an empty
      // `filesystem-files`. Here the collection is about to exist anyway. Never throws.
      await ensureFilenameIndex(collection);

      const fileInfo: FilesystemFileInfo = {
        _id,
        contentType: options.contentType,
        filename: options.filename,
        length: stats.size,
        ...(options.metadata ? { metadata: options.metadata } : {}),
        // Records WHERE the bytes went, so a reader never has to probe all three
        // stores to find out. Legacy documents lack it and are handled by probing.
        storage: 'filesystem',
        uploadDate: new Date(),
      };
      await collection.insertOne(fileInfo as any);
      return fileInfo;
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Find file metadata by ID
   */
  static async findFileById(
    collection: FileCollection,
    id: string | Types.ObjectId,
  ): Promise<FilesystemFileInfo | null> {
    return findMetadataById(collection, id);
  }

  /**
   * Find file metadata by filename
   */
  static async findFileByName(collection: FileCollection, filename: string): Promise<FilesystemFileInfo | null> {
    return findMetadataByName(collection, filename);
  }

  /**
   * Find files with filter and options
   */
  static async findFiles(
    collection: FileCollection,
    filter: any = {},
    options: any = {},
  ): Promise<FilesystemFileInfo[]> {
    return findMetadata(collection, filter, options);
  }

  /**
   * Delete a file from disk and remove its metadata.
   *
   * The metadata goes last: a missing file with a metadata row answers 404
   * through the normal "file document without bytes" path, while a stored file
   * with no metadata row is invisible to every lookup and can never be cleaned
   * up through the API.
   */
  static async deleteFile(directory: string, collection: FileCollection, id: string | Types.ObjectId): Promise<void> {
    const objectId = typeof id === 'string' ? new Types.ObjectId(id) : id;
    await rm(FilesystemFileHelper.filePath(directory, objectId), { force: true });
    await collection.deleteOne({ _id: objectId });
  }

  /**
   * Get the download stream of a file
   */
  static getStream(directory: string, id: string | Types.ObjectId): Readable {
    return createReadStream(FilesystemFileHelper.filePath(directory, id));
  }

  /**
   * Get the content of a file as a buffer
   */
  static async getBuffer(directory: string, id: string | Types.ObjectId): Promise<Buffer> {
    return streamToBuffer(FilesystemFileHelper.getStream(directory, id));
  }
}
