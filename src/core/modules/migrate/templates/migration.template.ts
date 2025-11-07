import { Db } from 'mongodb';

/**
 * Migration template for nest-server
 *
 * This template can be used with the migrate CLI:
 * migrate create --template-file ./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/templates/migration.template.js
 *
 * Or copy this file to your project's migrations-utils folder and customize it.
 */

/**
 * Get database connection
 *
 * IMPORTANT: Replace this function with your actual database connection logic.
 * This is a placeholder that should import your project's config.
 */
const getDb = async (): Promise<Db> => {
  // TODO: Import your config and return the database connection
  // Example:
  // import config from '../src/config.env';
  // const { MongoClient } = require('mongodb');
  // const client = await MongoClient.connect(config.mongoose.uri);
  // return client.db();

  throw new Error(
    'Please configure the getDb() function in this migration file or use the migration helper from @lenne.tech/nest-server',
  );
};

/**
 * Run migration
 *
 * Code your update script here!
 */
export const up = async () => {
  const db: Db = await getDb();

  // Example: Add a new field to all documents in a collection
  // await db.collection('users').updateMany(
  //   { email: { $exists: false } },
  //   { $set: { email: '' } }
  // );
};

/**
 * Rollback migration
 *
 * Code your downgrade script here!
 */
export const down = async () => {
  const db: Db = await getDb();

  // Example: Remove the field added in the up() function
  // await db.collection('users').updateMany(
  //   {},
  //   { $unset: { email: '' } }
  // );
};
