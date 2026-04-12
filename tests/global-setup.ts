import { MongoClient } from 'mongodb';

import envConfig from '../src/config.env';

/**
 * Vitest global setup: Drop the test database before running tests
 * to ensure a clean state with no leftovers from previous runs.
 */
export async function setup() {
  const connection = await MongoClient.connect(envConfig.mongoose.uri);
  const db = connection.db();
  await db.dropDatabase();
  console.info(`Dropped database: ${db.databaseName}`);
  await connection.close();
}
