import { NotFoundException } from '@nestjs/common';
import mongoose, { Connection, mongo, Types } from 'mongoose';
import { Readable } from 'stream';

import { FilterArgs } from '../../common/args/filter.args';
import { getObjectIds, getStringIds } from '../../common/helpers/db.helper';
import { convertFilterArgsToQuery } from '../../common/helpers/filter.helper';
import { GridFSHelper } from '../../common/helpers/gridfs.helper';
import { check } from '../../common/helpers/input.helper';
import { prepareOutput } from '../../common/helpers/service.helper';
import { ConfigService } from '../../common/services/config.service';
import { CoreS3Service } from '../../common/services/core-s3.service';
import { MaybePromise } from '../../common/types/maybe-promise.type';
import { CoreFileInfo } from './core-file-info.model';
import { FileServiceOptions } from './interfaces/file-service-options.interface';
import { FileUpload, FileUploadSource } from './interfaces/file-upload.interface';
import { S3_FILES_COLLECTION, S3FileHelper, S3FileInfo, streamToBuffer } from './s3-file.helper';

/**
 * Type for checking input
 */
export type FileInputCheckType = 'file' | 'filename' | 'files' | 'filterArgs' | 'id';

/**
 * Optional dependencies of CoreFileService.
 *
 * Both are required for the S3 storage driver (`fileStorage: 's3'`); without
 * them the service behaves exactly as before and stores everything in GridFS.
 */
export interface CoreFileServiceOptions {
  configService?: ConfigService;
  s3Service?: CoreS3Service;
}

/**
 * Abstract core file service
 */
export abstract class CoreFileService {
  // Use the native MongoDB driver's types (accessed via Mongoose's exports) to avoid BSON version conflicts
  files: mongo.GridFSBucket;

  /** Metadata collection for files stored in S3 (no Mongoose schema) */
  protected s3Files: mongo.Collection<any>;

  /**
   * Include MongoDB connection and create File bucket
   */
  protected constructor(
    protected readonly connection: Connection,
    bucketName = 'fs',
    protected readonly options?: CoreFileServiceOptions,
  ) {
    // Use the native MongoDB driver's GridFSBucket via Mongoose's mongo export to avoid BSON version conflicts
    this.files = new mongo.GridFSBucket(connection.db, { bucketName });
    this.s3Files = connection.db.collection(S3_FILES_COLLECTION);
  }

  /**
   * Whether new files are stored in S3 (`fileStorage: 's3'` and S3 configured).
   * Reads keep checking GridFS as fallback, so files written before the switch
   * stay available.
   */
  protected get s3Storage(): boolean {
    return (
      !!this.options?.s3Service?.enabled
      && this.options?.configService?.getFastButReadOnly<string>('fileStorage') === 's3'
    );
  }

  /**
   * Save file in DB
   */
  async createFile(file: MaybePromise<FileUploadSource>, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(file, { ...serviceOptions, checkInputType: 'file' }))) {
      return null;
    }
    const { createReadStream, filename, mimetype } = await file;
    const readStream = createReadStream();
    if (this.s3Storage) {
      const s3FileInfo = await S3FileHelper.writeFile(this.options.s3Service, this.s3Files, {
        buffer: await streamToBuffer(readStream),
        contentType: mimetype,
        filename,
      });
      return this.prepareOutput(s3FileInfo as unknown as CoreFileInfo, serviceOptions);
    }
    const fileInfo = await GridFSHelper.writeFileFromStream(this.files, readStream, {
      contentType: mimetype,
      filename,
    });
    return this.prepareOutput(fileInfo as unknown as CoreFileInfo, serviceOptions);
  }

  /**
   * Save files in DB
   */
  async createFiles(
    files: MaybePromise<FileUploadSource>[],
    serviceOptions?: FileServiceOptions,
  ): Promise<CoreFileInfo[]> {
    if (!(await this.checkRights(files, { ...serviceOptions, checkInputType: 'files' }))) {
      return null;
    }
    const promises: Promise<CoreFileInfo>[] = [];
    for (const file of files) {
      promises.push(this.createFile(file, serviceOptions));
    }
    return await Promise.all(promises);
  }

  /**
   * Duplicate file by name
   */
  async duplicateByName(name: string, newName: string): Promise<any> {
    return GridFSHelper.openDownloadStreamByName(this.files, name).pipe(
      GridFSHelper.openUploadStream(this.files, newName),
    );
  }

  /**
   * Duplicate file by ID
   */
  async duplicateById(id: string): Promise<string> {
    const objectId = getObjectIds(id);
    const file = await this.getFileInfo(objectId);
    return new Promise((resolve, reject) => {
      const downloadStream = GridFSHelper.openDownloadStream(this.files, objectId);

      const newFileId = new mongoose.Types.ObjectId();
      const uploadStream = GridFSHelper.openUploadStreamWithId(this.files, newFileId, file.filename, {
        contentType: file.contentType,
      });

      downloadStream.pipe(uploadStream);

      uploadStream.on('finish', () => {
        resolve(getStringIds(newFileId));
      });

      uploadStream.on('error', (err: { message: any }) => {
        reject(new Error(`File duplication failed: ${err.message}`));
      });

      downloadStream.on('error', (err: { message: any }) => {
        reject(new Error(`File download failed: ${err.message}`));
      });
    });
  }

  /**
   * Get file infos via filter
   */
  async findFileInfo(filterArgs?: FilterArgs, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo[]> {
    if (!(await this.checkRights(filterArgs, { ...serviceOptions, checkInputType: 'filterArgs' }))) {
      return null;
    }
    const filterQuery = convertFilterArgsToQuery(filterArgs);
    const docs = await GridFSHelper.findFiles(this.files, filterQuery[0], filterQuery[1]);
    if (this.s3Storage) {
      const s3Docs = await S3FileHelper.findFiles(this.s3Files, filterQuery[0], filterQuery[1]);
      return this.prepareOutput([...s3Docs, ...docs] as unknown as CoreFileInfo[], serviceOptions);
    }
    return this.prepareOutput(docs as unknown as CoreFileInfo[], serviceOptions);
  }

  /**
   * Get info about file via file ID
   */
  async getFileInfo(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    const fileInfo = (await this.findS3FileById(id)) || (await GridFSHelper.findFileById(this.files, getObjectIds(id)));
    return this.prepareOutput(fileInfo as unknown as CoreFileInfo, serviceOptions);
  }

  /**
   * Get info about file via filename
   */
  async getFileInfoByName(filename: string, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
    }
    const fileInfo = (await this.findS3FileByName(filename)) || (await GridFSHelper.findFileByName(this.files, filename));
    return this.prepareOutput(fileInfo as unknown as CoreFileInfo, serviceOptions);
  }

  /**
   * Get file stream (for big files) via file ID
   */
  async getFileStream(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions): Promise<Readable> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    if (await this.findS3FileById(id)) {
      return S3FileHelper.getStream(this.options.s3Service, id);
    }
    return GridFSHelper.openDownloadStream(this.files, getObjectIds(id)) as mongo.GridFSBucketReadStream;
  }

  /**
   * Get a presigned download URL for a file stored in S3.
   *
   * Returns undefined when the file is not in S3 or `s3.presignedDownloads` is
   * disabled — callers then fall back to streaming the file themselves.
   */
  async getDownloadUrl(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions): Promise<string | undefined> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return undefined;
    }
    const fileInfo = await this.findS3FileById(id);
    if (!fileInfo) {
      return undefined;
    }
    return this.options.s3Service.getPresignedDownloadUrl(getObjectIds(id).toHexString(), fileInfo.filename);
  }

  /**
   * Get file stream (for big files) via filename
   */
  async getFileStreamByName(filename: string, serviceOptions?: FileServiceOptions): Promise<Readable> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
    }
    const s3FileInfo = await this.findS3FileByName(filename);
    if (s3FileInfo) {
      return S3FileHelper.getStream(this.options.s3Service, s3FileInfo._id);
    }
    return GridFSHelper.openDownloadStreamByName(this.files, filename);
  }

  /**
   * Get file buffer (for small files) via file ID
   */
  async getBuffer(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions): Promise<Buffer> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    if (await this.findS3FileById(id)) {
      return S3FileHelper.getBuffer(this.options.s3Service, id);
    }
    return await GridFSHelper.readFileToBuffer(this.files, { _id: getObjectIds(id) });
  }

  /**
   * Get file buffer (for small files) via filename
   */
  async getBufferByName(filename: string, serviceOptions?: FileServiceOptions): Promise<Buffer> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
    }
    const s3FileInfo = await this.findS3FileByName(filename);
    if (s3FileInfo) {
      return S3FileHelper.getBuffer(this.options.s3Service, s3FileInfo._id);
    }
    return await GridFSHelper.readFileToBuffer(this.files, { filename });
  }

  /**
   * Delete file
   */
  async deleteFile(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    const objectId = getObjectIds(id);
    const fileInfo = await this.getFileInfo(objectId, serviceOptions);
    if (await this.findS3FileById(objectId)) {
      await S3FileHelper.deleteFile(this.options.s3Service, this.s3Files, objectId);
      return fileInfo;
    }
    await GridFSHelper.deleteFile(this.files, objectId);
    return fileInfo;
  }

  /**
   * Delete file reference of avatar
   */
  async deleteFileByName(filename: string, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
    }
    const fileInfo = await this.getFileInfoByName(filename);
    if (!fileInfo) {
      throw new NotFoundException(`File not found with filename ${filename}`);
    }
    return await this.deleteFile(fileInfo.id, serviceOptions);
  }

  // ===================================================================================================================
  //  Helper methods
  // ===================================================================================================================

  /**
   * Find the S3 metadata of a file by ID (null when S3 storage is off or the file is in GridFS)
   */
  protected async findS3FileById(id: string | Types.ObjectId): Promise<null | S3FileInfo> {
    return this.s3Storage ? S3FileHelper.findFileById(this.s3Files, getObjectIds(id)) : null;
  }

  /**
   * Find the S3 metadata of a file by filename (null when S3 storage is off or the file is in GridFS)
   */
  protected async findS3FileByName(filename: string): Promise<null | S3FileInfo> {
    return this.s3Storage ? S3FileHelper.findFileByName(this.s3Files, filename) : null;
  }

  /**
   * Check rights before processing file handling
   * Can throw an exception if the rights do not fit
   */
  protected checkRights(
    _input: any,
    _options?: FileServiceOptions & { checkInputType: FileInputCheckType },
  ): MaybePromise<boolean> {
    return true;
  }

  /**
   * Prepare output before return - single file
   * Accepts both GridFSFileInfo (from GridFS operations) and CoreFileInfo
   * They are structurally compatible (duck typing), so we use type assertion
   */
  protected async prepareOutput(fileInfo: CoreFileInfo, options?: FileServiceOptions): Promise<CoreFileInfo>;
  protected async prepareOutput(fileInfo: null, options?: FileServiceOptions): Promise<null>;
  protected async prepareOutput(fileInfo: CoreFileInfo[], options?: FileServiceOptions): Promise<CoreFileInfo[]>;
  protected async prepareOutput(
    fileInfo: CoreFileInfo | CoreFileInfo[] | null,
    options?: FileServiceOptions,
  ): Promise<CoreFileInfo | CoreFileInfo[] | null> {
    if (!fileInfo) {
      return fileInfo;
    }
    this.setId(fileInfo);
    const prepared = await prepareOutput(fileInfo, { targetModel: CoreFileInfo });
    return check(prepared, options?.currentUser, { roles: options?.roles });
  }

  /**
   * Set file info ID via _id
   */
  protected setId(fileInfo: CoreFileInfo | CoreFileInfo[]) {
    if (Array.isArray(fileInfo)) {
      fileInfo.forEach((item) => {
        if (typeof item === 'object') {
          item.id = getStringIds(item._id);
        }
      });
    } else if (typeof fileInfo === 'object') {
      fileInfo.id = getStringIds(fileInfo._id);
    }
    return fileInfo;
  }
}
