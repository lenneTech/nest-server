import { getDb, uploadFileToGridFS } from '@lenne.tech/nest-server';
import { Db, ObjectId } from 'mongodb';
import config from '../src/config.env';

/**
 * Migration template for nest-server projects
 *
 * This template is ready-to-use for @lenne.tech/nest-server projects.
 * It imports the necessary helpers and config automatically.
 *
 * Available helpers:
 * - getDb(uri): Get MongoDB connection
 * - uploadFileToGridFS(uri, filePath, options): Upload file to GridFS
 */

const MONGO_URL = config.mongoose.uri;

/**
 * Run migration
 *
 * Code your update script here!
 */
export const up = async () => {
  const db: Db = await getDb(MONGO_URL);

  // Example: Add a new field to all documents in a collection
  // await db.collection('users').updateMany(
  //   { email: { $exists: false } },
  //   { $set: { email: '' } }
  // );

  // Example: Upload a file to GridFS
  // const fileId: ObjectId = await uploadFileToGridFS(
  //   MONGO_URL,
  //   '../assets/image.png',
  //   { bucketName: 'images', filename: 'logo.png' }
  // );
};

/**
 * Rollback migration
 *
 * Code your downgrade script here!
 */
export const down = async () => {
  const db: Db = await getDb(MONGO_URL);

  // Example: Remove the field added in the up() function
  // await db.collection('users').updateMany(
  //   {},
  //   { $unset: { email: '' } }
  // );
};
