import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import * as mongo from 'mongodb';
import { Connection, Types } from 'mongoose';

import { ModelRegistry } from '../../../common/services/model-registry.service';
import { HubActionMessage } from '../hub-action-messages';
import { HUB_CONFIG } from '../hub.constants';
import { buildErDiagram, HubModelDescriptor, HubModelField } from '../helpers/hub-mermaid.helper';
import { HubDbData, HubFilesData, HubModelsData, HubUnavailable } from '../interfaces/hub-panels.interface';
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
   * Delete a GridFS file by id. When `expectedFilename` is given it must match the stored filename
   * (the type-to-confirm keyword). Returns the filename; throws when not found or the name mismatches.
   */
  async deleteFile(id: string, expectedFilename?: string, bucket = 'fs'): Promise<{ filename: string; id: string }> {
    const db = this.connection?.db;
    if (!db) {
      throw new Error(HubActionMessage.mongoUnavailable);
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new Error(HubActionMessage.invalidFileId);
    }
    const objectId = new Types.ObjectId(id);
    const [doc] = await db.collection(`${bucket}.files`).find({ _id: objectId }, { limit: 1 }).toArray();
    if (!doc) {
      throw new Error(HubActionMessage.fileNotFound);
    }
    if (expectedFilename !== undefined && expectedFilename !== doc.filename) {
      throw new Error(HubActionMessage.confirmationFilenameMismatch);
    }
    const gridFs = new mongo.GridFSBucket(db as unknown as mongo.Db, { bucketName: bucket });
    await gridFs.delete(objectId as unknown as mongo.ObjectId);
    return { filename: doc.filename, id };
  }

  /** GridFS file inventory for the given bucket (default `fs`). */
  async getFiles(bucket = 'fs', skip = 0, limit = 100): Promise<HubFilesData | HubUnavailable> {
    const db = this.connection?.db;
    if (!db) {
      return { available: false, hint: 'No MongoDB connection is available.' };
    }
    const filesCollection = `${bucket}.files`;
    try {
      const cursor = db
        .collection(filesCollection)
        .find({}, { limit: Math.min(limit, 500), skip, sort: { uploadDate: -1 } });
      const docs = await cursor.toArray();
      const total = await db.collection(filesCollection).countDocuments();
      return {
        bucket,
        files: docs.map((doc) => ({
          contentType: doc.contentType ?? doc.metadata?.contentType,
          filename: doc.filename,
          id: String(doc._id),
          length: doc.length ?? 0,
          uploadDate: doc.uploadDate ? new Date(doc.uploadDate).toISOString() : undefined,
        })),
        total,
      };
    } catch (error) {
      this.logger.warn(`Failed to list GridFS files: ${error instanceof Error ? error.message : String(error)}`);
      return { available: false, hint: `No GridFS bucket "${bucket}" or it is empty.` };
    }
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
