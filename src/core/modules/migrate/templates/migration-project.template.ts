import { getDb, uploadFileToGridFS } from '@lenne.tech/nest-server';
import { Db, ObjectId } from 'mongodb';
import { createRequire } from 'node:module';
import { join } from 'node:path';

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
 * 1. the project's config.env — next to `migrations/` when run from source (through the `--compiler ts:` loader), or
 *    the compiled `dist/src/config.env.js` when run from `dist/migrations`
 * 2. NSC__MONGOOSE__URI environment variable (Docker production)
 */

// `createRequire` rather than `require`, so the migration works in CommonJS and ESM projects alike. `__dirname` exists
// in a CommonJS project only and finds config.env relative to this file — in the source tree and in `dist/` alike. An ES
// module project has no `__dirname` here; it falls back to the directory the migrate scripts run from.
const projectRequire = createRequire(join(process.cwd(), 'package.json'));
const configCandidates = [
  ...(typeof __dirname === 'string' ? [join(__dirname, '..', 'src', 'config.env')] : []),
  join(process.cwd(), 'src', 'config.env'),
  join(process.cwd(), 'dist', 'src', 'config.env'),
];

let configuredUri: string | undefined;
for (const candidate of configCandidates) {
  try {
    const config = projectRequire(candidate);
    configuredUri = (config.default || config).mongoose?.uri;
  } catch {
    // Not loadable in this layout — try the next one.
  }
  if (configuredUri) {
    break;
  }
}
const MONGO_URL = configuredUri ?? process.env.NSC__MONGOOSE__URI;
if (!MONGO_URL) {
  throw new Error('MongoDB URI not available. Set NSC__MONGOOSE__URI or ensure config.env is loadable.');
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
  //   '../assets/image.png', // relative to this migration file
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
