import { MongoClient } from 'mongodb';

import envConfig from '../src/config.env';
import { SAFE_TEST_DB_PATTERN, splitMongoUri } from './db-lifecycle.reporter';

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
 * like the previous behavior — but only if it names a disposable test database
 * (see the guard below).
 */
export async function setup() {
  if (process.env.MONGODB_URI) {
    const connection = await MongoClient.connect(process.env.MONGODB_URI);
    const db = connection.db();

    // Never drop a database that is not recognizably a test database. This branch drops
    // whatever MONGODB_URI points at, and that variable is not always a test DB: a running
    // `lt dev` session exports it pointing at the project's DEVELOPMENT database, so without
    // this guard, running the suite from that shell silently wipes the developer's data.
    if (!SAFE_TEST_DB_PATTERN.test(db.databaseName)) {
      await connection.close();
      throw new Error(
        `Refusing to dropDatabase("${db.databaseName}"): not a recognized test database `
          + `(expected a name matching ${SAFE_TEST_DB_PATTERN}). `
          + 'MONGODB_URI must point at a disposable test database.',
      );
    }

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
