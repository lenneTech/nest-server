import { mongo, Types } from 'mongoose';
import { Readable } from 'stream';

// Use Mongoose's MongoDB types to avoid BSON version conflicts
const ObjectId = Types.ObjectId;

/**
 * GridFS File Info interface matching the structure from GridFS
 * This is the normalized structure with contentType at root level
 */
export interface GridFSFileInfo {
  _id: Types.ObjectId;
  chunkSize: number;
  /**
   * Content type of the file
   * Note: Stored in metadata.contentType in MongoDB, normalized to root level by helper
   */
  contentType?: string;
  filename: string;
  length: number;
  metadata?: Record<string, any> & { contentType?: string };
  uploadDate: Date;
}

/**
 * Options for reading files from GridFS
 */
export interface GridFSReadOptions {
  _id?: string | Types.ObjectId;
  filename?: string;
}
/**
 * Options for writing files to GridFS
 */
export interface GridFSWriteOptions {
  contentType?: string;
  filename: string;
  metadata?: Record<string, any>;
}

type GridFSBucket = mongo.GridFSBucket;

type GridFSBucketReadStream = mongo.GridFSBucketReadStream;

/**
 * Raw GridFS file structure as returned by MongoDB
 * This is the internal structure before normalization
 */
interface RawGridFSFile {
  _id: Types.ObjectId;
  chunkSize: number;
  filename: string;
  length: number;
  metadata?: Record<string, any> & { contentType?: string };
  uploadDate: Date;
}

/**
 * Helper class for GridFS operations using native MongoDB driver
 * Provides Promise-based API for all GridFS operations
 */
export class GridFSHelper {
  /**
   * Normalize file info to ensure contentType is accessible at root level
   * MongoDB stores contentType in metadata, but our API expects it at root
   */
  private static normalizeFileInfo(fileInfo: RawGridFSFile): GridFSFileInfo {
    return {
      ...fileInfo,
      contentType: fileInfo.metadata?.contentType,
    };
  }

  /**
   * Write a file to GridFS from a stream.
   *
   * **The SOURCE stream needs its own error handler.** `pipe()` does not forward
   * errors, so an error on `stream` used to have no listener at all: Node turns an
   * unhandled `'error'` event into an uncaught exception, which takes the whole
   * process down. That is reachable from ordinary traffic — a client that aborts a
   * GraphQL upload mid-body errors the capacitor stream — and it was
   * driver-conditional: the same abort is a rejected promise under the S3 driver
   * (`streamToBuffer` throws) and under the filesystem driver (`pipeline()`
   * forwards both ends), and a process crash under GridFS, the pre-11.33 default.
   * The migration helper's `uploadFileToGridFS()` already carried this handler; the
   * one on the request path did not.
   *
   * The partial upload is aborted rather than left behind: without it the failed
   * write keeps its chunks in `fs.chunks` with no `fs.files` document naming them,
   * which nothing can ever find or clean up.
   */
  static writeFileFromStream(
    bucket: GridFSBucket,
    stream: Readable,
    options: GridFSWriteOptions,
  ): Promise<GridFSFileInfo> {
    return new Promise((resolve, reject) => {
      // Store contentType in metadata to avoid deprecation warning
      const metadata = { ...options.metadata };
      if (options.contentType) {
        metadata.contentType = options.contentType;
      }

      const uploadStream = bucket.openUploadStream(options.filename, {
        metadata,
      });

      // One settle guard for all three paths: aborting a write stream can itself
      // emit, and a second rejection after a resolve would otherwise be silent.
      let settled = false;
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const succeed = (fileInfo: GridFSFileInfo) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(fileInfo);
      };

      stream.on('error', (error) => {
        // Discard the chunks already written — see the note above.
        Promise.resolve(uploadStream.abort?.()).catch(() => undefined);
        fail(error);
      });

      uploadStream.on('error', (error) => {
        // `pipe()` only unpipes on a destination error; the source would stay open,
        // holding a GridFS read cursor or an upload capacitor for nothing.
        if (!stream.destroyed) {
          stream.destroy();
        }
        fail(error);
      });

      uploadStream.on('finish', () => {
        // Fetch the file info after upload completes
        bucket
          .find({ _id: uploadStream.id })
          .toArray()
          .then((files) => {
            if (files && files.length > 0) {
              succeed(GridFSHelper.normalizeFileInfo(files[0]));
            } else {
              fail(new Error('File uploaded but metadata not found'));
            }
          })
          .catch(fail);
      });

      stream.pipe(uploadStream);
    });
  }

  /**
   * Read a file from GridFS to a buffer
   */
  static readFileToBuffer(bucket: GridFSBucket, options: GridFSReadOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let downloadStream: GridFSBucketReadStream;

      if (options._id) {
        const objectId = typeof options._id === 'string' ? new ObjectId(options._id) : options._id;
        downloadStream = bucket.openDownloadStream(objectId);
      } else if (options.filename) {
        downloadStream = bucket.openDownloadStreamByName(options.filename);
      } else {
        return reject(new Error('Either _id or filename must be provided'));
      }

      downloadStream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      downloadStream.on('error', (error) => {
        reject(error);
      });

      downloadStream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
  }

  /**
   * Find file metadata by ID
   */
  static async findFileById(bucket: GridFSBucket, id: string | Types.ObjectId): Promise<GridFSFileInfo | null> {
    const objectId = typeof id === 'string' ? new ObjectId(id) : id;
    const files = await bucket.find({ _id: objectId }).toArray();
    return files.length > 0 ? GridFSHelper.normalizeFileInfo(files[0]) : null;
  }

  /**
   * Find file metadata by filename
   */
  static async findFileByName(bucket: GridFSBucket, filename: string): Promise<GridFSFileInfo | null> {
    const files = await bucket.find({ filename }).toArray();
    return files.length > 0 ? GridFSHelper.normalizeFileInfo(files[0]) : null;
  }

  /**
   * Find files with filter and options.
   *
   * The `contentType` key is rewritten to `metadata.contentType` in BOTH the
   * filter and the sort — the exact mirror image of what
   * {@link GridFSHelper.normalizeFileInfo} does on the way out.
   *
   * Without it, `contentType` was the one field where the three storage drivers
   * were not equivalent: `s3-files` / `filesystem-files` carry it at the root of
   * the document, GridFS keeps it inside `metadata` (the driver dropped the
   * top-level option in mongodb 7). A `findFileInfo()` filtered on `contentType`
   * therefore matched every S3 / filesystem file and NO GridFS file — silently
   * returning nothing at all on the default driver, and silently dropping the
   * pre-switch files on any other. That is exactly the "switching drivers is
   * forward-only, no migration" promise failing for one field.
   */
  static async findFiles(bucket: GridFSBucket, filter: any = {}, options: any = {}): Promise<GridFSFileInfo[]> {
    const query = GridFSHelper.mapContentTypeKeys(filter);
    const findOptions =
      options && options.sort ? { ...options, sort: GridFSHelper.mapContentTypeKeys(options.sort) } : options;
    const files = await bucket.find(query, findOptions).toArray();
    return files.map((file) => GridFSHelper.normalizeFileInfo(file));
  }

  /**
   * Rename a top-level `contentType` key to `metadata.contentType`, recursing
   * through the logical operators `generateFilterQuery()` can emit.
   *
   * Deliberately narrow: only that one key is touched, only where it names a
   * field, and an already-qualified `metadata.contentType` is left alone. Nothing
   * else about the query is interpreted.
   */
  private static mapContentTypeKeys(value: any): any {
    if (Array.isArray(value)) {
      return value.map((entry) => GridFSHelper.mapContentTypeKeys(entry));
    }
    if (!value || typeof value !== 'object' || value instanceof RegExp || value instanceof Date) {
      return value;
    }
    const mapped: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Only the logical operators hold nested FIELD maps; `$gt`, `$in`, `$regex`
      // and friends hold VALUES, which must be passed through untouched.
      const nested = key === '$and' || key === '$nor' || key === '$or' ? GridFSHelper.mapContentTypeKeys(entry) : entry;
      mapped[key === 'contentType' ? 'metadata.contentType' : key] = nested;
    }
    return mapped;
  }

  /**
   * Delete a file from GridFS
   */
  static async deleteFile(bucket: GridFSBucket, id: string | Types.ObjectId): Promise<void> {
    const objectId = typeof id === 'string' ? new ObjectId(id) : id;
    await bucket.delete(objectId);
  }

  /**
   * Open download stream by ID
   */
  static openDownloadStream(bucket: GridFSBucket, id: string | Types.ObjectId): GridFSBucketReadStream {
    const objectId = typeof id === 'string' ? new ObjectId(id) : id;
    return bucket.openDownloadStream(objectId);
  }

  /**
   * Open download stream by name
   */
  static openDownloadStreamByName(bucket: GridFSBucket, filename: string): GridFSBucketReadStream {
    return bucket.openDownloadStreamByName(filename);
  }

  /**
   * Open upload stream
   */
  static openUploadStream(
    bucket: GridFSBucket,
    filename: string,
    options?: { contentType?: string },
  ): mongo.GridFSBucketWriteStream {
    // Store contentType in metadata (mongodb 7.x no longer has contentType option)
    if (options?.contentType) {
      const metadata = { contentType: options.contentType };
      return bucket.openUploadStream(filename, { metadata });
    }
    return bucket.openUploadStream(filename);
  }

  /**
   * Open upload stream with specific ID
   */
  static openUploadStreamWithId(
    bucket: GridFSBucket,
    id: Types.ObjectId,
    filename: string,
    options?: { contentType?: string },
  ): mongo.GridFSBucketWriteStream {
    // Store contentType in metadata (mongodb 7.x no longer has contentType option)
    if (options?.contentType) {
      const metadata = { contentType: options.contentType };
      return bucket.openUploadStreamWithId(id, filename, { metadata });
    }
    return bucket.openUploadStreamWithId(id, filename);
  }
}
