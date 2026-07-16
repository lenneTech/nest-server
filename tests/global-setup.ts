import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { MongoClient } from 'mongodb';

import envConfig from '../src/config.env';
import { isStaleTestDb, SAFE_TEST_DB_PATTERN, splitMongoUri } from './db-lifecycle.reporter';
import { acquireRunSlot } from './e2e-run-slots';

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
 * Three additional responsibilities (in execution order):
 *
 * 1. STARTUP SWEEP — drop every stale leftover DB of this project's base name
 *    (dead creating PID, over the age cap, or legacy-named). The end-of-run
 *    cleanup in db-lifecycle.reporter.ts cannot run when a run is SIGKILLed
 *    (check.mjs watchdog escalation, closed terminal) or when vitest was
 *    started with an explicit `--reporter` flag (which replaces the config
 *    reporters). Sweeping at STARTUP makes cleanup independent of how the
 *    previous run died: restarting the suite always restores a clean state.
 *
 * 2. RUN GOVERNOR — acquire a machine-wide e2e slot (tests/e2e-run-slots.ts)
 *    so at most N e2e suites run concurrently across ALL lt projects/sessions
 *    on this machine. Measured on 12 cores: one full-speed run takes ~34s at
 *    load 9; two concurrent runs drive load to 30 and produce spurious 401
 *    failures. Queuing is faster AND stable. The slot is released by the
 *    teardown below; a killed process's slot is reclaimed via PID-liveness.
 *
 * 3. UNIQUE RUN DB — as before.
 *
 * Lifecycle (see tests/db-lifecycle.reporter.ts):
 * - run PASSES → its database is dropped right away, plus stale leftovers;
 * - run FAILS → its database is KEPT for debugging and removed automatically
 *   by the next run (startup sweep or end-of-run collection).
 *
 * An externally provided MONGODB_URI (e.g. CI service container) opts out of
 * the unique-name scheme AND the sweep/governor: that URI is used as-is and
 * dropped up front, exactly like the previous behavior — but only if it names
 * a disposable test database (see the guard below).
 */

let releaseRunSlot: (() => void) | undefined;

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

  // 0. Filesystem sweep — remove upload-test artifacts (`tests/*.txt` / `*.bin`)
  // left behind by aborted file-upload specs. Same philosophy as the DB sweep
  // below: restarting the suite restores a clean state no matter how the
  // previous run died. No tracked fixtures match these patterns (git-verified);
  // `pnpm run test:cleanup` remains for manual use.
  try {
    // vitest runs globalSetup with cwd = project root (config `root: './'`).
    const testsDir = join(process.cwd(), 'tests');
    for (const entry of readdirSync(testsDir)) {
      if ((entry.endsWith('.txt') || entry.endsWith('.bin')) && entry !== '.gitkeep') {
        unlinkSync(join(testsDir, entry));
      }
    }
  } catch {
    /* best-effort — never block the run on artifact cleanup */
  }

  // 1. Startup sweep — restore a clean state regardless of how earlier runs ended.
  try {
    const connection = await MongoClient.connect(`${serverUri}/${dbName}${query}`);
    try {
      const { databases } = await connection.db().admin().listDatabases({ nameOnly: true });
      const swept: string[] = [];
      for (const { name } of databases) {
        if (isStaleTestDb(name, dbName) && SAFE_TEST_DB_PATTERN.test(name)) {
          await connection.db(name).dropDatabase();
          swept.push(name);
        }
      }
      if (swept.length > 0) {
        console.info(`Startup sweep: dropped ${swept.length} stale test database(s): ${swept.join(', ')}`);
      }
    } finally {
      await connection.close();
    }
  } catch (error) {
    // Best-effort: a failed sweep must never block the test run itself.
    console.warn(
      `Startup sweep skipped: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  // 2. Machine-wide run governor — wait for a free e2e slot before spawning forks.
  releaseRunSlot = await acquireRunSlot();

  // 3. Unique per-run database.
  const runDbName = `${dbName}-run-${Date.now()}-p${process.pid}`;
  process.env.MONGODB_URI = `${serverUri}/${runDbName}${query}`;
  console.info(`Test database for this run: ${runDbName}`);
}

export async function teardown() {
  releaseRunSlot?.();
  releaseRunSlot = undefined;
}
