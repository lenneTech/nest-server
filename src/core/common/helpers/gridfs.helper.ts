import { mongo, Types } from 'mongoose';
import { Readable } from 'stream';

// Use Mongoose's MongoDB types to avoid BSON version conflicts
const ObjectId = Types.ObjectId;
/**
 * GridFS File Info interface matching the structure from GridFS
 */
export interface GridFSFileInfo {
  _id: Types.ObjectId;
  chunkSize: number;
  contentType?: string;
  filename: string;
  length: number;
  metadata?: Record<string, any>;
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
 * Helper class for GridFS operations using native MongoDB driver
 * Provides Promise-based API for all GridFS operations
 */
export class GridFSHelper {
  /**
   * Write a file to GridFS from a stream
   */
  static writeFileFromStream(
    bucket: GridFSBucket,
    stream: Readable,
    options: GridFSWriteOptions,
  ): Promise<GridFSFileInfo> {
    return new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(options.filename, {
        contentType: options.contentType,
        metadata: options.metadata,
      });

      uploadStream.on('error', (error) => {
        reject(error);
      });

      uploadStream.on('finish', () => {
        // Fetch the file info after upload completes
        bucket
          .find({ _id: uploadStream.id })
          .toArray()
          .then((files) => {
            if (files && files.length > 0) {
              resolve(files[0] as GridFSFileInfo);
            } else {
              reject(new Error('File uploaded but metadata not found'));
            }
          })
          .catch(reject);
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
    return files.length > 0 ? (files[0] as GridFSFileInfo) : null;
  }

  /**
   * Find file metadata by filename
   */
  static async findFileByName(bucket: GridFSBucket, filename: string): Promise<GridFSFileInfo | null> {
    const files = await bucket.find({ filename }).toArray();
    return files.length > 0 ? (files[0] as GridFSFileInfo) : null;
  }

  /**
   * Find files with filter and options
   */
  static async findFiles(bucket: GridFSBucket, filter: any = {}, options: any = {}): Promise<GridFSFileInfo[]> {
    const files = await bucket.find(filter, options).toArray();
    return files as GridFSFileInfo[];
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
  static openUploadStream(bucket: GridFSBucket, filename: string, options?: { contentType?: string }): any {
    return bucket.openUploadStream(filename, options);
  }

  /**
   * Open upload stream with specific ID
   */
  static openUploadStreamWithId(
    bucket: GridFSBucket,
    id: Types.ObjectId,
    filename: string,
    options?: { contentType?: string },
  ): any {
    return bucket.openUploadStreamWithId(id, filename, options);
  }
}
