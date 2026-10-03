import { Types } from 'mongoose';
import { Readable } from 'stream';

import { CoreS3Service } from '../../common/services/core-s3.service';
import {
  ensureFilenameIndex,
  FileCollection,
  FileMetadataInfo,
  findMetadata,
  findMetadataById,
  findMetadataByName,
} from './file-metadata.helper';

/**
 * Name of the MongoDB collection holding the metadata of S3-stored files.
 *
 * S3 itself has no queryable metadata store, so file info (filename, contentType,
 * length, uploadDate) is kept in this collection — the equivalent of GridFS's
 * `fs.files`. The object key in the bucket is the string form of `_id`.
 */
export const S3_FILES_COLLECTION = 's3-files';

/**
 * Metadata of a file stored in S3.
 *
 * Alias of the shared {@link FileMetadataInfo}, kept as a named export because it is
 * part of the published API. It used to be a separate, structurally identical
 * declaration alongside `FilesystemFileInfo` — which is how the two lookup surfaces
 * drifted apart. One declaration now, so they cannot.
 */
export type S3FileInfo = FileMetadataInfo;

/**
 * Whether an upload size can be handed to S3 as the object's `Content-Length`.
 *
 * Only a positive safe integer qualifies. Anything else — `undefined`, `0`, a negative number,
 * `NaN`, a fraction — is treated as "length unknown" and goes through the multipart path, which
 * needs no total. The direction matters: a WRONG length is not a slower upload but a broken one,
 * whereas an unknown length only costs the multipart round trips. `0` is included in "unknown" because it is
 * what an unset numeric field defaults to far more often than it is a real empty file — and an
 * empty file stores correctly through the multipart path too.
 */
export function isKnownUploadSize(size: unknown): size is number {
  return typeof size === 'number' && Number.isSafeInteger(size) && size > 0;
}

/**
 * Read a stream completely into a buffer
 */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Helper for files stored in S3 with their metadata in MongoDB.
 *
 * Counterpart of GridFSHelper: same operations, S3 as the byte store and
 * `s3-files` as the metadata store.
 */
export class S3FileHelper {
  /**
   * Store a file in S3 and record its metadata.
   *
   * The object is verified via HEAD before the metadata document is written, so
   * a file info is never returned for bytes that did not arrive (same guarantee
   * GridFSHelper gives by reading the file document back after the upload).
   */
  static async writeFile(
    s3Service: CoreS3Service,
    collection: FileCollection,
    options: {
      body?: Readable;
      buffer?: Buffer;
      contentLength?: number;
      contentType?: string;
      filename: string;
      metadata?: Record<string, any>;
    },
  ): Promise<S3FileInfo> {
    const _id = new Types.ObjectId();
    const key = _id.toHexString();

    // A stream is never read into a Buffer here. Doing so — which every caller used to do —
    // materialises the WHOLE file in one process: a 4 GB resumable upload (well inside the 50 GB
    // default cap) then either throws "Array buffer allocation failed" or gets the container
    // OOM-killed at 100% progress, taking every other in-flight request with it. With a known
    // length the stream goes up as one PutObject; without one, `putObject()` uploads it in parts.
    const body = options.body ?? options.buffer;
    if (!body) {
      throw new Error('S3FileHelper.writeFile needs either a body stream or a buffer');
    }
    const contentLength = isKnownUploadSize(options.contentLength) ? options.contentLength : options.buffer?.length;
    await s3Service.putObject(key, body, options.contentType, contentLength);

    return S3FileHelper.recordFile(s3Service, collection, _id, {
      contentType: options.contentType,
      filename: options.filename,
      length: contentLength,
      metadata: options.metadata,
    });
  }

  /**
   * Adopt an object that ALREADY lives in the same S3 endpoint into file storage.
   *
   * The bytes are moved by S3 itself (`CopyObject`) rather than pulled into this process and
   * pushed back out — see {@link CoreS3Service.copyObject}. Used for the TUS S3→S3 hand-off,
   * where source and destination are two buckets of the same store.
   *
   * The metadata document is written by the same {@link S3FileHelper.recordFile} the streaming
   * path uses, so the two cannot drift into producing differently-shaped file infos.
   */
  static async copyFile(
    s3Service: CoreS3Service,
    collection: FileCollection,
    options: {
      contentLength?: number;
      contentType?: string;
      filename: string;
      metadata?: Record<string, any>;
      sourceBucket?: string;
      sourceKey: string;
    },
  ): Promise<S3FileInfo> {
    const _id = new Types.ObjectId();
    await s3Service.copyObject(options.sourceKey, _id.toHexString(), options.sourceBucket, options.contentType);

    return S3FileHelper.recordFile(s3Service, collection, _id, {
      contentType: options.contentType,
      filename: options.filename,
      length: options.contentLength,
      metadata: options.metadata,
    });
  }

  /**
   * Verify the object arrived and record its metadata.
   *
   * The HEAD before the insert is what keeps a file info from ever describing bytes that are not
   * there (the guarantee GridFSHelper gets by reading the file document back after the upload).
   */
  protected static async recordFile(
    s3Service: CoreS3Service,
    collection: FileCollection,
    _id: Types.ObjectId,
    options: { contentType?: string; filename: string; length?: number; metadata?: Record<string, any> },
  ): Promise<S3FileInfo> {
    // One HEAD answers both questions: whether the bytes arrived, and — for a stream whose length
    // nobody knew up front — how many there are. The stored object is the authority on its size;
    // a length guessed by the caller (a multipart request's `Content-Length`, say) is not.
    const stat = await s3Service.statObject(_id.toHexString());
    if (!stat) {
      throw new Error('File uploaded but not found in S3');
    }

    // On the WRITE path, not the read path: createIndex creates the collection, so
    // ensuring it when reading gave a GridFS-only deployment an empty `s3-files`.
    // Here the collection is about to exist anyway. Never throws.
    await ensureFilenameIndex(collection);

    const fileInfo: S3FileInfo = {
      _id,
      contentType: options.contentType,
      filename: options.filename,
      length: options.length ?? stat.contentLength,
      metadata: options.metadata,
      // Records WHERE the bytes went, so a reader never has to probe all three
      // stores to find out. Legacy documents lack it and are handled by probing.
      storage: 's3',
      uploadDate: new Date(),
    };
    await collection.insertOne(fileInfo);
    return fileInfo;
  }

  /**
   * Find file metadata by ID
   */
  static async findFileById(collection: FileCollection, id: string | Types.ObjectId): Promise<null | S3FileInfo> {
    return findMetadataById(collection, id);
  }

  /**
   * Find file metadata by filename
   */
  static async findFileByName(collection: FileCollection, filename: string): Promise<null | S3FileInfo> {
    return findMetadataByName(collection, filename);
  }

  /**
   * Find files with filter and options
   */
  static async findFiles(collection: FileCollection, filter: any = {}, options: any = {}): Promise<S3FileInfo[]> {
    return findMetadata(collection, filter, options);
  }

  /**
   * Delete a file from S3 and remove its metadata
   */
  static async deleteFile(
    s3Service: CoreS3Service,
    collection: FileCollection,
    id: string | Types.ObjectId,
  ): Promise<void> {
    const objectId = typeof id === 'string' ? new Types.ObjectId(id) : id;
    await s3Service.deleteObject(objectId.toHexString());
    await collection.deleteOne({ _id: objectId });
  }

  /**
   * Get the download stream of a file
   */
  static async getStream(s3Service: CoreS3Service, id: string | Types.ObjectId): Promise<Readable> {
    const objectId = typeof id === 'string' ? new Types.ObjectId(id) : id;
    return (await s3Service.getObject(objectId.toHexString())).body;
  }

  /**
   * Get the content of a file as buffer
   */
  static async getBuffer(s3Service: CoreS3Service, id: string | Types.ObjectId): Promise<Buffer> {
    return streamToBuffer(await S3FileHelper.getStream(s3Service, id));
  }
}
