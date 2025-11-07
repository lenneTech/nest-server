// import { Db } from 'mongodb';

/**
 * Migration template with helper function
 *
 * This template uses the migration helper from @lenne.tech/nest-server.
 * To use this template, you need to create a helper function in your project
 * that returns the database connection.
 *
 * Example setup in your project's migrations-utils/db.ts:
 * ```typescript
 * import config from '../src/config.env';
 * import { MongoClient } from 'mongodb';
 *
 * export const getDb = async () => {
 *   const client = await MongoClient.connect(config.mongoose.uri);
 *   return client.db();
 * };
 * ```
 */

// Import your project's database helper
// import { getDb } from '../migrations-utils/db';

// Or use the nest-server helper with your config:
// import config from '../src/config.env';
// import { getDb } from '@lenne.tech/nest-server';
// const db = await getDb(config.mongoose.uri);

/**
 * Run migration
 */
export const up = async () => {
  // const db: Db = await getDb();
  /*
    Code your update script here!

    Example: Add a new field to all documents
    await db.collection('users').updateMany(
      { email: { $exists: false } },
      { $set: { email: '' } }
    );

    Example: Create a new collection
    await db.createCollection('new_collection');

    Example: Create an index
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
  */
};

/**
 * Rollback migration
 */
export const down = async () => {
  // const db: Db = await getDb();
  /*
    Code your downgrade script here!

    Example: Remove the field added in up()
    await db.collection('users').updateMany(
      {},
      { $unset: { email: '' } }
    );

    Example: Drop the collection
    await db.dropCollection('new_collection');

    Example: Drop the index
    await db.collection('users').dropIndex('email_1');
  */
};
