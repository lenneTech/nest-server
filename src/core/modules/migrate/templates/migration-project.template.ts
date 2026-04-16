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
 * MongoDB URI resolution (in order):
 * 1. config.env.ts (local development via ts-node)
 * 2. NSC__MONGOOSE__URI environment variable (Docker production)
 */

let MONGO_URL: string;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require('../src/config.env');
  MONGO_URL = (config.default || config).mongoose.uri;
} catch {
  // Fallback for Docker production where config.env.ts is not available as TypeScript source
  if (!process.env.NSC__MONGOOSE__URI) {
    throw new Error('MongoDB URI not available. Set NSC__MONGOOSE__URI or ensure config.env.ts is loadable.');
  }
  MONGO_URL = process.env.NSC__MONGOOSE__URI;
}

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
