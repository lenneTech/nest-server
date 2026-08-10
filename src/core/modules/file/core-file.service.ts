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
import { FileUploadSource } from './interfaces/file-upload.interface';
import {
  assertFileStorageAvailable,
  FileStorageDriver,
  FileStorageResolution,
  logFileStorage,
  resolveFileStorage,
} from './file-storage.helper';
import {
  DEFAULT_FILESYSTEM_DIR,
  FILESYSTEM_FILES_COLLECTION,
  FilesystemFileHelper,
  FilesystemFileInfo,
} from './filesystem-file.helper';
import { S3_FILES_COLLECTION, S3FileHelper, S3FileInfo, streamToBuffer } from './s3-file.helper';

/**
 * Type for checking input
 */
export type FileInputCheckType = 'file' | 'filename' | 'files' | 'filterArgs' | 'id';

/**
 * Optional dependencies of CoreFileService.
 *
 * Both are required for the S3 storage driver (`file.storage: 's3'`); without
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

  /** Metadata collection for files stored on the local filesystem (no Mongoose schema) */
  protected filesystemFiles: mongo.Collection<any>;

  /** Which driver new files are written to, and why */
  protected readonly storageResolution: FileStorageResolution;

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
    this.filesystemFiles = connection.db.collection(FILESYSTEM_FILES_COLLECTION);

    // Resolve from the global config rather than the optional injected
    // ConfigService: a project on the pre-11.33 constructor (`super(connection)`)
    // forwards no services, and must still get a correctly derived driver.
    this.storageResolution = resolveFileStorage(ConfigService.configFastButReadOnly);
    assertFileStorageAvailable(this.storageResolution, this.isStorageAvailable(this.storageResolution.driver));
    logFileStorage(this.storageResolution);
  }

  /**
   * The driver new files are written to.
   *
   * Reads are not restricted to it: every store is consulted, so files written
   * before a driver change stay readable and switching is forward-only with no
   * migration step.
   */
  protected get storageDriver(): FileStorageDriver {
    return this.storageResolution.driver;
  }

  /** Directory used by the `'filesystem'` driver */
  protected get filesystemDir(): string {
    return ConfigService.configFastButReadOnly?.file?.storageDir || DEFAULT_FILESYSTEM_DIR;
  }

  /**
   * Whether a driver can actually be used right now.
   *
   * GridFS and the filesystem need nothing beyond what the constructor already
   * has (a database connection, a writable directory). S3 needs both the client
   * library and the service wired through `super()`.
   */
  protected isStorageAvailable(driver: FileStorageDriver): boolean {
    return driver === 's3' ? !!this.options?.s3Service?.enabled : true;
  }

  /**
   * @deprecated Use `storageDriver === 's3'`. Kept so an override or a project
   * that read this keeps compiling.
   */
  protected get s3Storage(): boolean {
    return this.storageDriver === 's3';
  }

  /** Whether new files go to the local filesystem */
  protected get filesystemStorage(): boolean {
    return this.storageDriver === 'filesystem';
  }

  /**
   * Find the filesystem metadata of a file by ID (null when it is stored elsewhere)
   */
  protected async findFilesystemFileById(id: string | Types.ObjectId): Promise<FilesystemFileInfo | null> {
    return FilesystemFileHelper.findFileById(this.filesystemFiles, getObjectIds(id));
  }

  /**
   * Find the filesystem metadata of a file by filename (null when it is stored elsewhere)
   */
  protected async findFilesystemFileByName(filename: string): Promise<FilesystemFileInfo | null> {
    return FilesystemFileHelper.findFileByName(this.filesystemFiles, filename);
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
    if (this.filesystemStorage) {
      const fsFileInfo = await FilesystemFileHelper.writeFile(this.filesystemDir, this.filesystemFiles, {
        body: readStream,
        contentType: mimetype,
        filename,
        ...(serviceOptions?.metadata ? { metadata: serviceOptions.metadata } : {}),
      });
      return this.prepareOutput(fsFileInfo as unknown as CoreFileInfo, serviceOptions);
    }
    if (this.storageDriver === 's3') {
      // Only buffer when the size is unknown: a GraphQL upload stream carries no length, and the
      // S3 SDK needs one. Callers that know it (TUS) pass `body` + `contentLength` instead and
      // stream straight through — see S3FileHelper.writeFile.
      const s3FileInfo = await S3FileHelper.writeFile(this.options.s3Service, this.s3Files, {
        buffer: await streamToBuffer(readStream),
        contentType: mimetype,
        filename,
        ...(serviceOptions?.metadata ? { metadata: serviceOptions.metadata } : {}),
      });
      return this.prepareOutput(s3FileInfo as unknown as CoreFileInfo, serviceOptions);
    }
    const fileInfo = await GridFSHelper.writeFileFromStream(this.files, readStream, {
      contentType: mimetype,
      filename,
      ...(serviceOptions?.metadata ? { metadata: serviceOptions.metadata } : {}),
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
    // Route through the storage dispatch like every other read/write. Going straight to GridFS
    // meant that with `file.storage: 's3'` the source simply is not there — and the resulting
    // FileNotFound arrives on a stream with NO error handler, so it becomes an uncaught
    // exception that takes the process down instead of a 404.
    const nonGridFsSource = (await this.findS3FileByName(name)) || (await this.findFilesystemFileByName(name));
    if (nonGridFsSource) {
      const source = await this.getFileStreamByName(name);
      return this.createFile({
        createReadStream: () => source,
        filename: newName,
        mimetype: nonGridFsSource.contentType || 'application/octet-stream',
      });
    }

    return new Promise((resolve, reject) => {
      const downloadStream = GridFSHelper.openDownloadStreamByName(this.files, name);
      downloadStream.on('error', reject);
      const uploadStream = GridFSHelper.openUploadStream(this.files, newName);
      uploadStream.on('error', reject);
      uploadStream.on('finish', () => resolve(uploadStream));
      downloadStream.pipe(uploadStream);
    });
  }

  /**
   * Duplicate file by ID
   */
  async duplicateById(id: string): Promise<string> {
    const objectId = getObjectIds(id);
    const file = await this.getFileInfo(objectId);

    // Same dispatch as duplicateByName: a file stored outside GridFS has no GridFS counterpart.
    const nonGridFsSource = (await this.findS3FileById(objectId)) || (await this.findFilesystemFileById(objectId));
    if (nonGridFsSource) {
      const source = await this.getFileStream(objectId);
      const copy = await this.createFile({
        createReadStream: () => source,
        filename: file.filename,
        mimetype: file.contentType || 'application/octet-stream',
      });
      return copy.id;
    }

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
    if (this.storageDriver === 'gridfs') {
      // Nothing was ever written to the other stores by this configuration, so the
      // single-store path stays exact: no merging, no over-fetching.
      const docs = await GridFSHelper.findFiles(this.files, filterQuery[0], filterQuery[1]);
      return this.prepareOutput(docs as unknown as CoreFileInfo[], serviceOptions);
    }

    // Several stores, one page. Applying `limit`/`skip` to each and concatenating returns up to
    // N times the page size and advances the offset independently in each store, so rows are both
    // duplicated and skipped — and a project that switched drivers with files already written
    // under the previous one (an explicitly supported state) hits exactly that. So: fetch enough
    // from each to cover skip+limit, merge, then page the merged result once.
    const { limit, skip, ...rest } = (filterQuery[1] ?? {}) as { limit?: number; skip?: number };
    const upperBound = limit === undefined ? undefined : (skip ?? 0) + limit;
    const pageOptions = upperBound === undefined ? rest : { ...rest, limit: upperBound };

    const [s3Docs, fsDocs, docs] = await Promise.all([
      S3FileHelper.findFiles(this.s3Files, filterQuery[0], pageOptions),
      FilesystemFileHelper.findFiles(this.filesystemFiles, filterQuery[0], pageOptions),
      GridFSHelper.findFiles(this.files, filterQuery[0], pageOptions),
    ]);

    const merged = [...s3Docs, ...fsDocs, ...docs];
    const paged = limit === undefined ? merged.slice(skip ?? 0) : merged.slice(skip ?? 0, (skip ?? 0) + limit);
    return this.prepareOutput(paged as unknown as CoreFileInfo[], serviceOptions);
  }

  /**
   * Get info about file via file ID
   */
  async getFileInfo(id: string | Types.ObjectId, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    // Every store is consulted, newest driver first, so a change of `file.storage`
    // never hides files written under the previous one.
    const fileInfo =
      (await this.findS3FileById(id)) ||
      (await this.findFilesystemFileById(id)) ||
      (await GridFSHelper.findFileById(this.files, getObjectIds(id)));
    return this.prepareOutput(fileInfo as unknown as CoreFileInfo, serviceOptions);
  }

  /**
   * Get info about file via filename
   */
  async getFileInfoByName(filename: string, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    if (!(await this.checkRights(filename, { ...serviceOptions, checkInputType: 'filename' }))) {
      return null;
    }
    const fileInfo =
      (await this.findS3FileByName(filename)) ||
      (await this.findFilesystemFileByName(filename)) ||
      (await GridFSHelper.findFileByName(this.files, filename));
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
    if (await this.findFilesystemFileById(id)) {
      return FilesystemFileHelper.getStream(this.filesystemDir, id);
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
    const fsFileInfo = await this.findFilesystemFileByName(filename);
    if (fsFileInfo) {
      return FilesystemFileHelper.getStream(this.filesystemDir, fsFileInfo._id);
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
    if (await this.findFilesystemFileById(id)) {
      return FilesystemFileHelper.getBuffer(this.filesystemDir, id);
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
    const fsFileInfo = await this.findFilesystemFileByName(filename);
    if (fsFileInfo) {
      return FilesystemFileHelper.getBuffer(this.filesystemDir, fsFileInfo._id);
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
    if (await this.findFilesystemFileById(objectId)) {
      await FilesystemFileHelper.deleteFile(this.filesystemDir, this.filesystemFiles, objectId);
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
   * Read a file's raw document, bypassing `prepareOutput`.
   *
   * `getFileInfo()` runs the result through `prepareOutput` → `check()`, which
   * strips fields the current user may not see — including `metadata`. That is
   * correct for a response, and useless for an authorization decision, which
   * has to look at the very field being protected.
   *
   * So this is the read side of a per-file rule: use it inside an overridden
   * `checkRights()`, never to build a response.
   *
   * Checks S3 metadata first, then GridFS — the same order as `getFileInfo()`,
   * so a rule written against this sees the same file the download would serve.
   * Getting that order wrong would make an owner check pass on a stale GridFS
   * document while the bytes come from S3.
   *
   * @param id file id
   * @returns the raw document, or null when no file has that id
   */
  protected async getRawFileInfo(id: string | Types.ObjectId): Promise<null | Record<string, any>> {
    const fileInfo =
      (await this.findS3FileById(id)) ||
      (await this.findFilesystemFileById(id)) ||
      (await GridFSHelper.findFileById(this.files, getObjectIds(id)));
    return (fileInfo as unknown as Record<string, any>) || null;
  }

  /**
   * Read a file's raw document by filename, bypassing `prepareOutput`.
   *
   * Companion to {@link getRawFileInfo} for the `checkInputType: 'filename'`
   * branch of `checkRights()`. Note that the filename route resolves the FIRST
   * match, so a rule built on this is only as strong as filename uniqueness in
   * your project — prefer authorizing by id where you can.
   */
  protected async getRawFileInfoByName(filename: string): Promise<null | Record<string, any>> {
    const fileInfo =
      (await this.findS3FileByName(filename)) || (await GridFSHelper.findFileByName(this.files, filename));
    return (fileInfo as unknown as Record<string, any>) || null;
  }

  /**
   * Check rights before processing file handling
   * Can throw an exception if the rights do not fit
   *
   * Returning `false` makes the caller answer as if the file did not exist
   * (`404`), so a refusal never confirms that an id is real.
   *
   * The role decorators on the controller and resolver are the COARSE filter —
   * they decide who may reach the endpoint at all, and are configurable via
   * `file.downloadRoles` / `uploadRoles` / `deleteRoles`. This hook is the fine
   * one: it is the only place that can express "…but only their OWN file".
   *
   * `options.currentUser` is populated by the core controller for both download
   * routes. Metadata to compare against must be written at upload time via
   * `serviceOptions.metadata` and read back with `getRawFileInfo()`.
   *
   * @example
   * ```typescript
   * protected override async checkRights(
   *   input: any,
   *   options?: FileServiceOptions & { checkInputType: FileInputCheckType },
   * ): Promise<boolean> {
   *   if (options?.checkInputType !== 'id' || options.force) {
   *     return true;
   *   }
   *   if (options.currentUser?.hasRole([RoleEnum.ADMIN])) {
   *     return true;
   *   }
   *   const raw = await this.getRawFileInfo(input);
   *   return !!raw && String(raw.metadata?.ownerId) === String(options.currentUser?.id);
   * }
   * ```
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
