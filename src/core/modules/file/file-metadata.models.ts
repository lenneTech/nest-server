import { Schema } from 'mongoose';

import { FILESYSTEM_FILES_COLLECTION } from './filesystem-file.helper.js';
import { S3_FILES_COLLECTION } from './s3-file.helper.js';

/**
 * The metadata of files whose bytes live in S3 or on the filesystem, as models — what routes them with `database`
 * like every other model (db-agnostic phase 4). On a SQL default source the rows live in the tables `s3_files` and
 * `filesystem_files`; on MongoDB the file helpers keep reading and writing the collections natively, as before.
 *
 * `autoCreate` and `autoIndex` are off: these schemas only register the models. A deployment that never writes to a
 * store must not grow an empty collection for it (`ensureFilenameIndex()` creates the index on the first write), and
 * nothing may create an index next to the one the helpers ensure. GridFS has no model here: its `fs.files` belongs to
 * the driver and stays on MongoDB.
 */

/** Model of the `s3-files` metadata */
export const S3_FILE_MODEL = 'CoreS3File';

/** Model of the `filesystem-files` metadata */
export const FILESYSTEM_FILE_MODEL = 'CoreFilesystemFile';

/** The shape both stores write — a GridFS `fs.files` document plus the `storage` marker (`FileMetadataInfo`) */
function fileMetadataSchema(collection: string): Schema {
  return new Schema(
    {
      contentType: { type: String },
      filename: { index: true, type: String },
      length: { type: Number },
      metadata: { type: Schema.Types.Mixed },
      storage: { type: String },
      uploadDate: { type: Date },
    },
    { autoCreate: false, autoIndex: false, collection, versionKey: false },
  );
}

/** Registered by `CoreModule` through `CorePersistenceModule.forFeature()` */
export const FILE_METADATA_MODELS = [
  { name: S3_FILE_MODEL, schema: fileMetadataSchema(S3_FILES_COLLECTION) },
  { name: FILESYSTEM_FILE_MODEL, schema: fileMetadataSchema(FILESYSTEM_FILES_COLLECTION) },
];
