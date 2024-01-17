import { MongoGridFSOptions, MongooseGridFS, createBucket } from '@lenne.tech/mongoose-gridfs';
import { NotFoundException } from '@nestjs/common';
import { GridFSBucket, GridFSBucketReadStream, GridFSBucketReadStreamOptions } from 'mongodb';
import { Connection, Types } from 'mongoose';

import { FilterArgs } from '../../common/args/filter.args';
import { getObjectIds, getStringIds } from '../../common/helpers/db.helper';
import { convertFilterArgsToQuery } from '../../common/helpers/filter.helper';
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

/**
 * Abstract core file service
 */
export abstract class CoreFileService {
  files: GridFSBucket & MongooseGridFS;

  /**
   * Include MongoDB connection and create File bucket
   */
  protected constructor(
    protected readonly connection: Connection,
    bucketName = 'fs',
  ) {
    this.files = createBucket({ bucketName, connection });
  }

  /**
   * Save file in DB
   */
  async createFile(file: MaybePromise<FileUpload>, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(file, { ...serviceOptions, checkInputType: 'file' }))) {
      return null;
    }
    return await new Promise(async (resolve, reject) => {
      // eslint-disable-next-line unused-imports/no-unused-vars
      const { createReadStream, encoding, filename, mimetype } = await file;
      const readStream = createReadStream();
      const options: MongoGridFSOptions = { contentType: mimetype, filename };
      this.files.writeFile(options, readStream, (error, fileInfo) => {
        error ? reject(error) : resolve(this.prepareOutput(fileInfo, serviceOptions));
      });
    });
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
   * Get file infos via filter
   */
  async findFileInfo(filterArgs?: FilterArgs, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo[]> {
    if (!(await this.checkRights(filterArgs, { ...serviceOptions, checkInputType: 'filterArgs' }))) {
      return null;
    }
    return await new Promise((resolve, reject) => {
      const filterQuery = convertFilterArgsToQuery(filterArgs);
      const cursor = this.files.find(filterQuery[0], filterQuery[1]);
      if (!cursor) {
        throw new NotFoundException('File collection not found');
      }
      cursor.toArray((error, docs) => {
        error ? reject(error) : resolve(this.prepareOutput(docs, serviceOptions));
      });
    });
  }

  /**
   * Get info about file via file ID
   */
  async getFileInfo(id: Types.ObjectId | string, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    return await new Promise((resolve, reject) => {
      this.files.findById(getObjectIds(id), (error, fileInfo) => {
        error ? reject(error) : resolve(this.prepareOutput(fileInfo, serviceOptions));
      });
    });
  }

  /**
   * Get info about file via filename
   */
  async getFileInfoByName(filename: string, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
    }
    return await new Promise((resolve, reject) => {
      this.files.findOne({ filename }, (error, fileInfo) => {
        error ? reject(error) : resolve(this.prepareOutput(fileInfo, serviceOptions));
      });
    });
  }

  /**
   * Get file stream (for big files) via file ID
   */
  async getFileStream(id: Types.ObjectId | string, serviceOptions?: FileServiceOptions) {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    return this.files.openDownloadStream(getObjectIds(id)) as GridFSBucketReadStream;
  }

  /**
   * Get file stream (for big files) via filename
   */
  async getFileStreamByName(
    filename: string,
    serviceOptions?: FileServiceOptions,
  ): Promise<GridFSBucketReadStreamOptions> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
    }
    return this.files.readFile({ filename });
  }

  /**
   * Get file buffer (for small files) via file ID
   */
  async getBuffer(id: Types.ObjectId | string, serviceOptions?: FileServiceOptions): Promise<Buffer> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    return await new Promise((resolve, reject) => {
      this.files.readFile({ _id: getObjectIds(id) }, (error, buffer) => {
        error ? reject(error) : resolve(buffer);
      });
    });
  }

  /**
   * Get file buffer (for small files) via file ID
   */
  async getBufferByName(filename: string, serviceOptions?: FileServiceOptions): Promise<Buffer> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
    }
    return await new Promise((resolve, reject) => {
      this.files.readFile({ filename }, (error, buffer) => {
        error ? reject(error) : resolve(buffer);
      });
    });
  }

  /**
   * Delete file reference of avatar
   */
  async deleteFile(id: Types.ObjectId | string, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    return await new Promise((resolve, reject) => {
      return this.files.unlink(getObjectIds(id), (error, fileInfo) => {
        error ? reject(error) : resolve(this.prepareOutput(fileInfo, serviceOptions));
      });
    });
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
