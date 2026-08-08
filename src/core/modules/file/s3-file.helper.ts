import { mongo, Types } from 'mongoose';
import { Readable } from 'stream';

import { CoreS3Service } from '../../common/services/core-s3.service';

/**
 * Name of the MongoDB collection holding the metadata of S3-stored files.
 *
 * S3 itself has no queryable metadata store, so file info (filename, contentType,
 * length, uploadDate) is kept in this collection — the equivalent of GridFS's
 * `fs.files`. The object key in the bucket is the string form of `_id`.
 */
export const S3_FILES_COLLECTION = 's3-files';

/**
 * Metadata of a file stored in S3 (mirrors GridFSFileInfo)
 */
export interface S3FileInfo {
  _id: Types.ObjectId;
  contentType?: string;
  filename: string;
  length: number;
  metadata?: Record<string, any>;
  uploadDate: Date;
}

type FileCollection = mongo.Collection<any>;

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
    options: { buffer: Buffer; contentType?: string; filename: string; metadata?: Record<string, any> },
  ): Promise<S3FileInfo> {
    const _id = new Types.ObjectId();
    const key = _id.toHexString();
    await s3Service.putObject(key, options.buffer, options.contentType);

    if (!(await s3Service.objectExists(key))) {
      throw new Error('File uploaded but not found in S3');
    }

    const fileInfo: S3FileInfo = {
      _id,
      contentType: options.contentType,
      filename: options.filename,
      length: options.buffer.length,
      metadata: options.metadata,
      uploadDate: new Date(),
    };
    await collection.insertOne(fileInfo);
    return fileInfo;
  }

  /**
   * Find file metadata by ID
   */
  static async findFileById(collection: FileCollection, id: string | Types.ObjectId): Promise<null | S3FileInfo> {
    const objectId = typeof id === 'string' ? new Types.ObjectId(id) : id;
    return (await collection.findOne({ _id: objectId })) as null | S3FileInfo;
  }

  /**
   * Find file metadata by filename
   */
  static async findFileByName(collection: FileCollection, filename: string): Promise<null | S3FileInfo> {
    return (await collection.findOne({ filename })) as null | S3FileInfo;
  }

  /**
   * Find files with filter and options
   */
  static async findFiles(collection: FileCollection, filter: any = {}, options: any = {}): Promise<S3FileInfo[]> {
    return (await collection.find(filter, options).toArray()) as unknown as S3FileInfo[];
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
