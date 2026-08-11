import { Logger, NotFoundException } from '@nestjs/common';
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

  protected readonly logger = new Logger(CoreFileService.name);

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

    // Each store returned its own rows already sorted; concatenating them does NOT
    // preserve that order, so without this re-sort a `sort` in the filter args held
    // only WITHIN a store and the merged page came out interleaved by store. Paging
    // a wrongly-ordered merge also returns the wrong rows, not just the right rows
    // in the wrong order.
    const merged = this.sortMergedFileInfo([...s3Docs, ...fsDocs, ...docs], (rest as { sort?: any }).sort);
    const paged = limit === undefined ? merged.slice(skip ?? 0) : merged.slice(skip ?? 0, (skip ?? 0) + limit);
    return this.prepareOutput(paged as unknown as CoreFileInfo[], serviceOptions);
  }

  /**
   * Re-apply a Mongo-style sort spec to rows merged from several stores.
   *
   * Only used on the multi-store path — the single-store path never merges and
   * keeps the database's own ordering. Falls back to `uploadDate` descending
   * (newest first), which is the order a file listing is expected in and the one
   * each store already returns on its own.
   */
  protected sortMergedFileInfo<T extends Record<string, any>>(docs: T[], sort?: Record<string, any>): T[] {
    const spec = Object.entries(sort ?? {}).filter(([, direction]) => direction === 1 || direction === -1);
    const effective: [string, number][] = spec.length ? (spec as [string, number][]) : [['uploadDate', -1]];
    return [...docs].sort((a, b) => {
      for (const [field, direction] of effective) {
        const left = a?.[field];
        const right = b?.[field];
        if (left === right) {
          continue;
        }
        // Undefined sorts last regardless of direction — a store that does not
        // carry the field must not win the page just because `undefined < x`.
        if (left === undefined || left === null) {
          return 1;
        }
        if (right === undefined || right === null) {
          return -1;
        }
        return left < right ? -direction : direction;
      }
      return 0;
    });
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
  async getFileStream(
    id: string | Types.ObjectId,
    serviceOptions?: FileServiceOptions,
    knownStore?: FileStorageDriver,
  ): Promise<Readable> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }
    // `knownStore` is a pure optimization, never an authorization shortcut: the
    // rights check above already ran. A caller that has just resolved the file
    // (the controller does, via resolveFile) can pass which store it came from so
    // the same one-to-three metadata round trips are not repeated per download.
    // Omitting it keeps the previous behaviour exactly.
    const store = knownStore ?? (await this.locateFile(id));
    if (store === 's3') {
      return S3FileHelper.getStream(this.options.s3Service, id);
    }
    if (store === 'filesystem') {
      return FilesystemFileHelper.getStream(this.filesystemDir, id);
    }
    return GridFSHelper.openDownloadStream(this.files, getObjectIds(id)) as mongo.GridFSBucketReadStream;
  }

  /**
   * Which store currently holds a file's bytes.
   *
   * Consults the stores in the same order as `getFileInfo()`. Answers `'gridfs'`
   * for an unknown id, which is what the download path did before this existed:
   * GridFS is the terminal fallback and reports the miss itself.
   */
  protected async locateFile(id: string | Types.ObjectId): Promise<FileStorageDriver> {
    if (await this.findS3FileById(id)) {
      return 's3';
    }
    if (await this.findFilesystemFileById(id)) {
      return 'filesystem';
    }
    return 'gridfs';
  }

  /**
   * Resolve a file's metadata AND which store holds its bytes, in one pass.
   *
   * A download used to answer the same question up to three times — once in
   * `getFileInfo()`, once in `getDownloadUrl()` and once in `getFileStream()` —
   * because each of them probed the stores in turn and then discarded which one
   * had answered. The probe order here is unchanged; what is new is that the
   * answering store is returned alongside the metadata, so the callers stop
   * re-probing.
   *
   * The store is derived from WHICH COLLECTION produced the document, never from
   * anything the document says about itself: the collection is the only source
   * that cannot disagree with where the bytes actually are.
   *
   * Runs the SAME `checkRights()` as `getFileInfo()` — it is a replacement for that
   * call, not a way around it.
   */
  async resolveFile(
    id: string | Types.ObjectId,
    serviceOptions?: FileServiceOptions,
  ): Promise<{ info: CoreFileInfo; store: FileStorageDriver } | null> {
    if (!(await this.checkRights(id, { ...serviceOptions, checkInputType: 'id' }))) {
      return null;
    }

    const s3Info = await this.findS3FileById(id);
    if (s3Info) {
      return { info: await this.prepareOutput(s3Info as unknown as CoreFileInfo, serviceOptions), store: 's3' };
    }

    const fsInfo = await this.findFilesystemFileById(id);
    if (fsInfo) {
      // The COLLECTION a document was found in is what says where the bytes are —
      // same as the S3 branch above. Reading the document's own `storage` marker
      // instead would agree in every sound case and disagree in exactly one: a
      // document sitting in `filesystem-files` while claiming `storage: 's3'`.
      // Believing it there hands `knownStore: 's3'` to `getFileStream()`, which
      // then reads bytes out of the wrong store.
      return {
        info: await this.prepareOutput(fsInfo as unknown as CoreFileInfo, serviceOptions),
        store: 'filesystem',
      };
    }

    const gridFsInfo = await GridFSHelper.findFileById(this.files, getObjectIds(id));
    if (!gridFsInfo) {
      return null;
    }
    return { info: await this.prepareOutput(gridFsInfo as unknown as CoreFileInfo, serviceOptions), store: 'gridfs' };
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
    // Forward the caller's context, exactly as deleteFile() does for getFileInfo().
    // Without it this method authorizes the caller and then re-resolves the file with
    // an EMPTY context, so an overridden checkRights() is asked two different
    // questions about one request. For an ownership rule that means the lookup denies
    // — and the caller gets `File not found` for a file that exists and that they were
    // just authorized for, which reads as a missing file rather than a refused one.
    const fileInfo = await this.getFileInfoByName(filename, serviceOptions);
    if (!fileInfo) {
      throw new NotFoundException(`File not found with filename ${filename}`);
    }
    return await this.deleteFile(fileInfo.id, serviceOptions);
  }

  // ===================================================================================================================
  //  Helper methods
  // ===================================================================================================================

  /**
   * Find the S3 metadata of a file by ID (null when S3 is not usable, or the file is in another store)
   *
   * Gated on whether S3 is USABLE, not on whether it is the active write driver.
   * Gating on the driver made the documented "reads consult every store, so
   * switching is forward-only" promise true only in one direction: adopting S3
   * kept GridFS readable, but switching back to `gridfs`/`filesystem` turned
   * every S3-stored file into a 404. The metadata lookup is a cheap indexed
   * `findOne`; the driver only decides where new bytes GO.
   */
  protected async findS3FileById(id: string | Types.ObjectId): Promise<null | S3FileInfo> {
    if (!this.isStorageAvailable('s3')) {
      return null;
    }
    return S3FileHelper.findFileById(this.s3Files, getObjectIds(id));
  }

  /**
   * Find the S3 metadata of a file by filename (null when S3 is not usable, or the file is in another store)
   *
   * See {@link findS3FileById} for why this is gated on availability, not on the
   * active driver.
   */
  protected async findS3FileByName(filename: string): Promise<null | S3FileInfo> {
    if (!this.isStorageAvailable('s3')) {
      return null;
    }
    return S3FileHelper.findFileByName(this.s3Files, filename);
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
   * Checks S3 metadata first, then the filesystem store, then GridFS — the same
   * three stores in the same order as `getFileInfo()`, so a rule written against
   * this sees the same file the download would serve. Getting that order wrong
   * would make an owner check pass on a stale GridFS document while the bytes
   * come from S3; omitting a store would make it decide on a file that is not
   * the one being served at all (see {@link getRawFileInfoByName}).
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
    // Same three stores, in the same order, as getRawFileInfo() and
    // getFileInfoByName(). Skipping the filesystem store here made a by-name
    // ownership rule see a DIFFERENT file set than the download serves: under
    // `file.storage: 'filesystem'` it returned null for a file the route then
    // happily streamed. That fails closed for the documented `!!raw && …` shape
    // and OPEN for the equally natural `if (!raw) return true`.
    const fileInfo =
      (await this.findS3FileByName(filename)) ||
      (await this.findFilesystemFileByName(filename)) ||
      (await GridFSHelper.findFileByName(this.files, filename));
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
   * **A missing `currentUser` must DENY.** This is the one part of the rule that
   * is easy to get backwards: "no user in context" is NOT "system-internal call"
   * — it is also exactly what an ANONYMOUS request looks like. The coarse gate
   * turns those away while `downloadRoles` is narrower than `S_EVERYONE`, so an
   * `if (!options.currentUser) return true` shortcut looks harmless — right up to
   * the moment a project widens the gate, at which point it hands every file to
   * everyone and the ownership rule evaporates precisely when it starts to
   * matter. Genuinely internal callers say so with `force: true`, or pass the
   * user they already have; see `src/server/modules/file` and
   * `src/server/modules/user/avatar.controller.ts`.
   *
   * **Cover the `filename` branch too, not just `id`.** An id-only rule is
   * enough while bytes are streamed, because the filename route resolves an id
   * and checks it again — but NOT once `s3.presignedDownloads` is enabled, where
   * the filename route authorizes on the by-name lookup alone and then redirects,
   * and not for `deleteFileByName()`, which authorizes by name only.
   *
   * The example below is the rule `src/server/modules/file/file.service.ts`
   * actually runs — it is compiled, type-checked and exercised end to end by
   * every file-touching e2e spec, plus the dedicated contract test in
   * `tests/file-ownership.e2e-spec.ts`. Prefer reading it there over copying
   * from here.
   *
   * @example
   * ```typescript
   * protected override async checkRights(
   *   input: any,
   *   options?: FileServiceOptions & { checkInputType: FileInputCheckType },
   * ): Promise<boolean> {
   *   if (options?.force || (options?.checkInputType !== 'filename' && options?.checkInputType !== 'id')) {
   *     return true;
   *   }
   *   if (options.currentUser?.hasRole?.([RoleEnum.ADMIN])) {
   *     return true;
   *   }
   *   const raw = options.checkInputType === 'id'
   *     ? await this.getRawFileInfo(input)
   *     : await this.getRawFileInfoByName(input);
   *   // Fails closed without a user: `String(undefined)` cannot equal a real owner id.
   *   // Requiring the owner to be PRESENT is load-bearing too — comparing a missing
   *   // ownerId against a missing user id would compare 'undefined' with 'undefined'.
   *   return !!raw?.metadata?.ownerId && String(raw.metadata.ownerId) === String(options.currentUser?.id);
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
