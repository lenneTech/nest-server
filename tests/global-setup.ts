import { MongoClient } from 'mongodb';

import envConfig from '../src/config.env';
import { splitMongoUri } from './db-lifecycle.reporter';

/**
 * Vitest global setup: give every test run its OWN database.
 *
 * Why not a fixed name + dropDatabase: two suites running at the same time
 * (second terminal, IDE runner, parallel agent session) would share one DB,
 * and the later run's drop wipes the earlier run's users/sessions mid-flight —
 * observed as sudden 401s and even wedged app bootstraps. A unique name per
 * run makes concurrent runs fully isolated.
 *
 * The name is set via process.env.MONGODB_URI BEFORE the fork workers spawn,
 * so config.env.ts inside every worker resolves to this run's database.
 *
 * Lifecycle (see tests/db-lifecycle.reporter.ts):
 * - run PASSES → its database is dropped right away, and stale run databases
 *   from earlier crashed/failed runs (dead PID or older than 7 days) plus the
 *   legacy fixed-name database are collected too;
 * - run FAILS → its database is KEPT for debugging and removed automatically
 *   by the next successful run.
 *
 * An externally provided MONGODB_URI (e.g. CI service container) opts out of
 * the unique-name scheme: that URI is used as-is and dropped up front, exactly
 * like the previous behavior.
 */
export async function setup() {
  if (process.env.MONGODB_URI) {
    const connection = await MongoClient.connect(process.env.MONGODB_URI);
    const db = connection.db();
    await db.dropDatabase();
    console.info(`Dropped externally configured test database: ${db.databaseName}`);
    await connection.close();
    return;
  }

  const { dbName, query, serverUri } = splitMongoUri(envConfig.mongoose.uri);
  const runDbName = `${dbName}-run-${Date.now()}-p${process.pid}`;
  process.env.MONGODB_URI = `${serverUri}/${runDbName}${query}`;
  console.info(`Test database for this run: ${runDbName}`);
}
