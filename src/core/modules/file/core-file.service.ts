import { NotFoundException } from '@nestjs/common';
import mongoose, { Connection, mongo, Types } from 'mongoose';

import { FilterArgs } from '../../common/args/filter.args';
import { getObjectIds, getStringIds } from '../../common/helpers/db.helper';
import { convertFilterArgsToQuery } from '../../common/helpers/filter.helper';
import { GridFSHelper } from '../../common/helpers/gridfs.helper';
import { check } from '../../common/helpers/input.helper';
import { prepareOutput } from '../../common/helpers/service.helper';
import { MaybePromise } from '../../common/types/maybe-promise.type';
import { CoreFileInfo } from './core-file-info.model';
import { FileServiceOptions } from './interfaces/file-service-options.interface';
import { FileUpload } from './interfaces/file-upload.interface';

/**
 * Type for checking input
 */
export type FileInputCheckType = 'file' | 'filename' | 'files' | 'filterArgs' | 'id';

// Use Mongoose's MongoDB types to avoid BSON version conflicts
type GridFSBucket = mongo.GridFSBucket;
type GridFSBucketReadStream = mongo.GridFSBucketReadStream;

/**
 * Abstract core file service
 */
export abstract class CoreFileService {
  files: GridFSBucket;

  /**
   * Include MongoDB connection and create File bucket
   */
  protected constructor(
    protected readonly connection: Connection,
    bucketName = 'fs',
  ) {
    // Use Mongoose's GridFSBucket to avoid BSON version conflicts
    this.files = new mongo.GridFSBucket(connection.db, { bucketName });
  }

  /**
   * Save file in DB
   */
  async createFile(file: MaybePromise<FileUpload>, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(file, { ...serviceOptions, checkInputType: 'file' }))) {
      return null;
    }
    // eslint-disable-next-line unused-imports/no-unused-vars
    const { createReadStream, encoding, filename, mimetype } = await file;
    const readStream = createReadStream();
    const fileInfo = await GridFSHelper.writeFileFromStream(this.files, readStream, {
      contentType: mimetype,
      filename,
    });
    return this.prepareOutput(fileInfo as any, serviceOptions);
  }

  /**
   * Save files in DB
   */
  async createFiles(files: MaybePromise<FileUpload>[], serviceOptions?: FileServiceOptions): Promise<CoreFileInfo[]> {
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
    return new Promise(async (resolve) => {
      resolve(
        GridFSHelper.openDownloadStreamByName(this.files, name).pipe(
          GridFSHelper.openUploadStream(this.files, newName),
        ),
      );
    });
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
    return this.prepareOutput(docs as any, serviceOptions);
  }

  /**
   * Get info about file via file ID
   */
  async getFileInfo(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    const fileInfo = await GridFSHelper.findFileById(this.files, getObjectIds(id));
    return this.prepareOutput(fileInfo as any, serviceOptions);
  }

  /**
   * Get info about file via filename
   */
  async getFileInfoByName(filename: string, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
    }
    const fileInfo = await GridFSHelper.findFileByName(this.files, filename);
    return this.prepareOutput(fileInfo as any, serviceOptions);
  }

  /**
   * Get file stream (for big files) via file ID
   */
  async getFileStream(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions) {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    return GridFSHelper.openDownloadStream(this.files, getObjectIds(id)) as GridFSBucketReadStream;
  }

  /**
   * Get file stream (for big files) via filename
   */
  async getFileStreamByName(filename: string, serviceOptions?: FileServiceOptions): Promise<GridFSBucketReadStream> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
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
    return await GridFSHelper.readFileToBuffer(this.files, { _id: getObjectIds(id) });
  }

  /**
   * Get file buffer (for small files) via filename
   */
  async getBufferByName(filename: string, serviceOptions?: FileServiceOptions): Promise<Buffer> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
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
   * Check rights before processing file handling
   * Can throw an exception if the rights do not fit
   */
  protected checkRights(
    input: any, // eslint-disable-line unused-imports/no-unused-vars
    options?: FileServiceOptions & { checkInputType: FileInputCheckType }, // eslint-disable-line unused-imports/no-unused-vars
  ): MaybePromise<boolean> {
    return true;
  }

  /**
   * Prepare output before return
   */
  protected async prepareOutput(fileInfo: CoreFileInfo | CoreFileInfo[], options?: FileServiceOptions) {
    if (!fileInfo) {
      return fileInfo;
    }
    this.setId(fileInfo);
    fileInfo = await prepareOutput(fileInfo, { targetModel: CoreFileInfo });
    return check(fileInfo, options?.currentUser, { roles: options?.roles });
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
