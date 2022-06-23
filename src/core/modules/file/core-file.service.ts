import { NotFoundException } from '@nestjs/common';
import { GridFSBucket, GridFSBucketReadStreamOptions } from 'mongodb';
import { Connection, Types } from 'mongoose';
import { createBucket, MongoGridFSOptions, MongooseGridFS } from 'mongoose-gridfs';
import { FilterArgs } from '../../common/args/filter.args';
import { getObjectIds, getStringIds } from '../../common/helpers/db.helper';
import { convertFilterArgsToQuery } from '../../common/helpers/filter.helper';
import { check } from '../../common/helpers/input.helper';
import { prepareOutput } from '../../common/helpers/service.helper';
import { MaybePromise } from '../../common/types/maybe-promise.type';
import { FileInfo } from './file-info.output';
import { FileServiceOptions } from './interfaces/file-service-options.interface';
import { FileUpload } from './interfaces/file-upload.interface';

/**
 * Abstract core file service
 */
export abstract class CoreFileService {
  files: GridFSBucket & MongooseGridFS;

  /**
   * Include MongoDB connection and create File bucket
   */
  protected constructor(protected readonly connection: Connection, modelName = 'File') {
    this.files = createBucket({ modelName, connection });
  }

  /**
   * Save file in DB
   */
  createFile(file: MaybePromise<FileUpload>, serviceOptions?: FileServiceOptions): Promise<FileInfo> {
    return new Promise(async (resolve, reject) => {
      const { filename, mimetype, encoding, createReadStream } = await file;
      const readStream = createReadStream();
      const options: MongoGridFSOptions = { filename, contentType: mimetype };
      this.files.writeFile(options, readStream, (error, fileInfo) => {
        error ? reject(error) : resolve(this.prepareOutput(fileInfo, serviceOptions));
      });
    });
  }

  /**
   * Save files in DB
   */
  async createFiles(files: MaybePromise<FileUpload>[], serviceOptions?: FileServiceOptions): Promise<FileInfo[]> {
    const promises: Promise<FileInfo>[] = [];
    for (const file of files) {
      promises.push(this.createFile(file, serviceOptions));
    }
    return await Promise.all(promises);
  }

  /**
   * Get file infos via filter
   */
  findFileInfo(filterArgs?: FilterArgs, serviceOptions?: FileServiceOptions): Promise<FileInfo[]> {
    return new Promise((resolve, reject) => {
      const filterQuery = convertFilterArgsToQuery(filterArgs);
      const cursor = this.files.find(filterQuery[0], filterQuery[1]);
      if (!cursor) {
        throw new Error('File collection not found');
      }
      cursor.toArray((error, docs) => {
        error ? reject(error) : resolve(this.prepareOutput(docs, serviceOptions));
      });
    });
  }

  /**
   * Get info about file via file ID
   */
  getFileInfo(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions): Promise<FileInfo> {
    return new Promise((resolve, reject) => {
      this.files.findById(getObjectIds(id), (error, fileInfo) => {
        error ? reject(error) : resolve(this.prepareOutput(fileInfo, serviceOptions));
      });
    });
  }

  /**
   * Get info about file via filename
   */
  getFileInfoByName(filename: string, serviceOptions?: FileServiceOptions): Promise<FileInfo> {
    return new Promise((resolve, reject) => {
      this.files.findOne({ filename }, (error, fileInfo) => {
        error ? reject(error) : resolve(this.prepareOutput(fileInfo, serviceOptions));
      });
    });
  }

  /**
   * Get file stream (for big files) via file ID
   */
  getFileStream(id: string | Types.ObjectId, options?: GridFSBucketReadStreamOptions) {
    return this.files.openDownloadStream(getObjectIds(id), options);
  }

  /**
   * Get file stream (for big files) via filename
   */
  getFileStreamByName(filename: string): GridFSBucketReadStreamOptions {
    return this.files.readFile({ filename });
  }

  /**
   * Get file buffer (for small files) via file ID
   */
  getBuffer(id: string | Types.ObjectId): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.files.readFile({ _id: getObjectIds(id) }, (error, buffer) => {
        error ? reject(error) : resolve(buffer);
      });
    });
  }

  /**
   * Get file buffer (for small files) via file ID
   */
  getBufferByName(filename: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.files.readFile({ filename }, (error, buffer) => {
        error ? reject(error) : resolve(buffer);
      });
    });
  }

  /**
   * Delete file reference of avatar
   */
  deleteFile(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions): Promise<FileInfo> {
    return new Promise((resolve, reject) => {
      return this.files.unlink(getObjectIds(id), (error, fileInfo) => {
        error ? reject(error) : resolve(this.prepareOutput(fileInfo, serviceOptions));
      });
    });
  }

  /**
   * Delete file reference of avatar
   */
  async deleteFileByName(filename: string, serviceOptions?: FileServiceOptions): Promise<FileInfo> {
    const fileInfo = await this.getFileInfoByName(filename);
    if (!fileInfo) {
      throw new NotFoundException('File not found with filename ' + filename);
    }
    return await this.deleteFile(fileInfo.id, serviceOptions);
  }

  // ===================================================================================================================
  //  Helper methods
  // ===================================================================================================================

  /**
   * Prepare output before return
   */
  protected async prepareOutput(fileInfo: FileInfo | FileInfo[], options?: FileServiceOptions) {
    if (!fileInfo) {
      return fileInfo;
    }
    this.setId(fileInfo);
    fileInfo = await prepareOutput(fileInfo, { targetModel: FileInfo });
    return check(fileInfo, options?.currentUser, { roles: options?.roles });
  }

  /**
   * Set file info ID via _id
   */
  protected setId(fileInfo: FileInfo | FileInfo[]) {
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
