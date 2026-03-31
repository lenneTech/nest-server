import { getDb, uploadFileToGridFS } from '@lenne.tech/nest-server';
import { Db, ObjectId } from 'mongodb';

/**
 * Migration template for nest-server projects
 *
 * This template is ready-to-use for @lenne.tech/nest-server projects.
 * It imports the necessary helpers and config automatically.
 *
 * Available helpers:
 * - getDb(uri): Get MongoDB connection
 * - uploadFileToGridFS(uri, filePath, options): Upload file to GridFS
 *
 * The MongoDB URI is read from the NSC__MONGOOSE__URI environment variable
 * so migrations work in Docker production where config.env.ts is not available
 * as a TypeScript source file.
 */

const MONGO_URL = process.env.NSC__MONGOOSE__URI || 'mongodb://127.0.0.1/test';

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
