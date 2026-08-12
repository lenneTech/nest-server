import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import * as mongo from 'mongodb';
import { Connection, Types } from 'mongoose';

import { ConfigService } from '../../../common/services/config.service';
import { CoreS3Service } from '../../../common/services/core-s3.service';
import { ModelRegistry } from '../../../common/services/model-registry.service';
import {
  DEFAULT_FILESYSTEM_DIR,
  FILESYSTEM_FILES_COLLECTION,
  FilesystemFileHelper,
} from '../../file/filesystem-file.helper';
import { S3_FILES_COLLECTION, S3FileHelper } from '../../file/s3-file.helper';
import { HubActionMessage } from '../hub-action-messages';
import { HUB_CONFIG } from '../hub.constants';
import { buildErDiagram, HubModelDescriptor, HubModelField } from '../helpers/hub-mermaid.helper';
import {
  HubDbData,
  HubFilesData,
  HubFileStore,
  HubFileStoreSummary,
  HubModelsData,
  HubUnavailable,
} from '../interfaces/hub-panels.interface';
import { ResolvedHubConfig } from '../interfaces/hub-config.interface';

/**
 * Read-only MongoDB introspection for the DB, Models/ERD and Files panels.
 *
 * Native driver access (`connection.db.*`) is used deliberately and only for admin read-only
 * operations (stats, listings) — allowed per docs/native-driver-security.md. No writes here.
 */
@Injectable()
export class CoreHubDbService {
  protected readonly logger = new Logger(CoreHubDbService.name);

  constructor(
    @Inject(HUB_CONFIG) protected readonly config: ResolvedHubConfig,
    @Optional() @InjectConnection() protected readonly connection?: Connection,
    // Provided and exported globally by `CoreModule`, but INERT without an `s3` config — so it is
    // optional here for the same reason it is everywhere else: a project that uses no S3 must not
    // be forced to install `@aws-sdk/client-s3` to open the Hub.
    @Optional() protected readonly s3Service?: CoreS3Service,
  ) {}

  /** Database + per-collection statistics. */
  async getDbStats(): Promise<HubDbData | HubUnavailable> {
    const dbConfig = this.config.db;
    if (dbConfig === false) {
      return { available: false, hint: 'The database panel is disabled (hub.db: false).' };
    }
    const db = this.connection?.db;
    if (!db) {
      return { available: false, hint: 'No MongoDB connection is available.' };
    }
    const includeIndexes = dbConfig.includeIndexes;

    try {
      const dbStats = await db.stats();
      const collectionInfos = await db.listCollections({}, { nameOnly: true }).toArray();

      // Read every collection's storage stats concurrently — sequential awaits made the DB panel's
      // latency scale linearly with the collection count.
      const collections = await Promise.all(
        collectionInfos.map(async (info) => {
          try {
            const [stats] = await db
              .collection(info.name)
              .aggregate([{ $collStats: { storageStats: {} } }])
              .toArray();
            const storage = stats?.storageStats ?? {};
            return {
              avgObjSize: storage.avgObjSize,
              count: storage.count ?? 0,
              indexCount: includeIndexes ? storage.nindexes : undefined,
              indexSize: includeIndexes ? storage.totalIndexSize : undefined,
              name: info.name,
              size: storage.size ?? 0,
              storageSize: storage.storageSize ?? 0,
            };
          } catch {
            return { count: 0, name: info.name, size: 0, storageSize: 0 };
          }
        }),
      );

      collections.sort((a, b) => b.size - a.size);

      return {
        collections,
        stats: {
          collections: dbStats.collections ?? collections.length,
          dataSize: dbStats.dataSize ?? 0,
          indexSize: dbStats.indexSize ?? 0,
          objects: dbStats.objects ?? 0,
          storageSize: dbStats.storageSize ?? 0,
        },
      };
    } catch (error) {
      this.logger.warn(`Failed to read DB stats: ${error instanceof Error ? error.message : String(error)}`);
      return { available: false, hint: 'Failed to read database statistics.' };
    }
  }

  /**
   * Delete a file by id, from WHICHEVER store actually holds it.
   *
   * When `expectedFilename` is given it must match the stored filename (the type-to-confirm
   * keyword). Returns the filename and the store it came from; throws when not found, when the name
   * mismatches, or when the owning store cannot be reached.
   *
   * This used to delete from GridFS only, which meant an S3- or filesystem-backed file could not be
   * removed from the Hub at all — the lookup answered `File not found.` for a file plainly sitting
   * in the bucket.
   */
  async deleteFile(
    id: string,
    expectedFilename?: string,
    bucket = 'fs',
  ): Promise<{ filename: string; id: string; store: HubFileStore }> {
    const db = this.connection?.db;
    if (!db) {
      throw new Error(HubActionMessage.mongoUnavailable);
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new Error(HubActionMessage.invalidFileId);
    }
    const objectId = new Types.ObjectId(id);

    // Same probe order as `CoreFileService.deleteFile()`: S3, then filesystem, then GridFS as the
    // fallthrough. Keeping the two in step matters — a Hub that resolved a file differently from the
    // service would delete a different file than the one it displayed.
    let store: HubFileStore | undefined;
    let doc: any;
    for (const candidate of this.fileStores(bucket)) {
      const [found] = await db.collection(candidate.collection).find({ _id: objectId }, { limit: 1 }).toArray();
      if (found) {
        doc = found;
        store = candidate.store;
        break;
      }
    }
    if (!doc || !store) {
      throw new Error(HubActionMessage.fileNotFound);
    }
    if (expectedFilename !== undefined && expectedFilename !== doc.filename) {
      throw new Error(HubActionMessage.confirmationFilenameMismatch);
    }

    switch (store) {
      case 'filesystem': {
        await FilesystemFileHelper.deleteFile(this.filesystemDir, db.collection(FILESYSTEM_FILES_COLLECTION), objectId);
        break;
      }
      case 's3': {
        // Refuse rather than half-delete — see HubActionMessage.s3Unavailable.
        if (!this.s3Service?.enabled) {
          throw new Error(HubActionMessage.s3Unavailable);
        }
        await S3FileHelper.deleteFile(this.s3Service, db.collection(S3_FILES_COLLECTION), objectId);
        break;
      }
      default: {
        const gridFs = new mongo.GridFSBucket(db as unknown as mongo.Db, { bucketName: bucket });
        await gridFs.delete(objectId as unknown as mongo.ObjectId);
      }
    }

    return { filename: doc.filename, id, store };
  }

  /**
   * File inventory across ALL THREE metadata stores.
   *
   * Metadata always lives in MongoDB whichever store holds the bytes (`fs.files` / `s3-files` /
   * `filesystem-files`), so one connection can see everything — which is exactly what
   * `CoreFileService.findFileInfo()` does, and what this panel now mirrors.
   *
   * It used to read `fs.files` alone. Under `file.storage: 's3'` or `'filesystem'` that made the
   * panel report **0 files** — not "this panel does not cover your driver", but a confident wrong
   * answer, in the one tool an operator opens BECAUSE they are unsure. Someone checking whether an
   * upload landed would have concluded it had not.
   *
   * Paging over a merge is the trap here: taking `skip`/`limit` from each store and concatenating
   * returns the wrong ROWS, not merely the wrong order (the same defect `sortMergedFileInfo()` was
   * fixed for). So each store yields its newest `skip + limit`, the union is re-sorted, and only
   * then is the window cut — which is correct because the global newest `skip + limit` rows are
   * necessarily contained in the per-store newest `skip + limit`.
   *
   * READS NEVER CREATE A COLLECTION: `find()` and `countDocuments()` on an absent collection answer
   * empty. A GridFS-only deployment therefore does not grow an empty `s3-files` from the Hub merely
   * looking at it — the same rule `ensureFilenameIndex()` follows on the write path.
   */
  async getFiles(bucket = 'fs', skip = 0, limit = 100): Promise<HubFilesData | HubUnavailable> {
    const db = this.connection?.db;
    if (!db) {
      return { available: false, hint: 'No MongoDB connection is available.' };
    }

    const safeSkip = Math.max(0, skip);
    const safeLimit = Math.min(Math.max(1, limit), 500);
    // Per-store window: enough to guarantee the merged page is complete, capped so a huge `skip`
    // cannot turn one panel poll into an unbounded read.
    const window = Math.min(safeSkip + safeLimit, 1000);

    const stores: HubFileStoreSummary[] = [];
    const rows: HubFilesData['files'] = [];

    for (const source of this.fileStores(bucket)) {
      try {
        const docs = await db
          .collection(source.collection)
          .find({}, { limit: window, sort: { uploadDate: -1 } })
          .toArray();
        const count = await db.collection(source.collection).countDocuments();
        stores.push({ collection: source.collection, count, store: source.store });
        for (const doc of docs) {
          rows.push({
            contentType: doc.contentType ?? doc.metadata?.contentType,
            filename: doc.filename,
            id: String(doc._id),
            length: doc.length ?? 0,
            store: source.store,
            uploadDate: doc.uploadDate ? new Date(doc.uploadDate).toISOString() : undefined,
          });
        }
      } catch (error) {
        // One unreadable store must not blank the panel: the other two still hold real answers, and
        // an operator is better served by "two stores listed, this one errored" than by nothing.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to list files in ${source.collection}: ${message}`);
        stores.push({ collection: source.collection, count: 0, error: message, store: source.store });
      }
    }

    rows.sort((a, b) => (b.uploadDate ?? '').localeCompare(a.uploadDate ?? ''));

    return {
      bucket,
      files: rows.slice(safeSkip, safeSkip + safeLimit),
      stores,
      total: stores.reduce((sum, entry) => sum + entry.count, 0),
    };
  }

  /** Directory used by the `'filesystem'` driver — resolved exactly as `CoreFileService` does. */
  protected get filesystemDir(): string {
    return ConfigService.configFastButReadOnly?.file?.storageDir || DEFAULT_FILESYSTEM_DIR;
  }

  /**
   * The three metadata stores, in the order both this service and `CoreFileService` probe them.
   *
   * GridFS is last because it is the fallthrough: its collection name depends on the bucket, and a
   * document there carries no `storage` marker to identify it by.
   */
  protected fileStores(bucket: string): { collection: string; store: HubFileStore }[] {
    return [
      { collection: S3_FILES_COLLECTION, store: 's3' },
      { collection: FILESYSTEM_FILES_COLLECTION, store: 'filesystem' },
      { collection: `${bucket}.files`, store: 'gridfs' },
    ];
  }

  /** Model inventory + a Mermaid ER diagram derived from the registered Mongoose schemas. */
  getModels(): HubModelsData {
    const descriptors = this.collectModelDescriptors();
    const mermaid = buildErDiagram(descriptors);
    const relationCount = descriptors.reduce((sum, m) => sum + m.fields.filter((f) => f.ref).length, 0);
    return {
      entities: descriptors.map((d) => ({ fields: d.fields, name: d.name })),
      mermaid,
      modelCount: descriptors.length,
      relationCount,
    };
  }

  /** Walk the live Mongoose connection's schemas into value-free descriptors for the ERD builder. */
  protected collectModelDescriptors(): HubModelDescriptor[] {
    const models = this.connection?.models ?? {};
    const registered = ModelRegistry.getAll();
    const names = new Set<string>([...Object.keys(models), ...registered.keys()]);
    const descriptors: HubModelDescriptor[] = [];

    for (const name of names) {
      const schema = models[name]?.schema;
      if (!schema) {
        descriptors.push({ fields: [], name });
        continue;
      }
      const fields: HubModelField[] = [];
      schema.eachPath((pathName: string, schemaType: any) => {
        if (pathName === '__v') {
          return;
        }
        fields.push({
          name: pathName,
          ref: schemaType?.options?.ref ?? schemaType?.caster?.options?.ref,
          type: schemaType?.instance ?? 'Mixed',
        });
      });
      descriptors.push({ fields, name });
    }

    descriptors.sort((a, b) => a.name.localeCompare(b.name));
    return descriptors;
  }
}
