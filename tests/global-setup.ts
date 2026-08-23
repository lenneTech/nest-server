import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { MongoClient } from 'mongodb';

import envConfig from '../src/config.env';
import {
  isDroppableTestDb,
  isStaleTestDb,
  NON_DISPOSABLE_DB_PATTERN,
  SAFE_TEST_DB_PATTERN,
  splitMongoUri,
} from './db-lifecycle.reporter';
import { acquireRunSlot } from './e2e-run-slots';
// Plain .mjs helper, shared with the npm scripts and CI
import { up as startTestInfra } from '../scripts/test-infra.mjs';

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

/**
 * File extensions the startup sweep removes from `tests/`.
 *
 * Kept in sync with `package.json` → `test:cleanup`. Every entry must be an
 * extension NO tracked file under `tests/` uses — verify with
 * `git ls-files tests | grep -iE '\.(png|txt|bin)$'` before widening it, or the
 * sweep starts deleting fixtures the suite reads.
 */
const ARTIFACT_EXTENSIONS = ['.bin', '.png', '.txt'];

export async function setup() {
  if (process.env.MONGODB_URI) {
    // A URI without a path (`mongodb://host`, `mongodb://host/`) makes the driver resolve to its
    // DEFAULT database, `test` — a name the guard below accepts, so a truncated or malformed
    // MONGODB_URI would drop the server's `test` database instead of failing. Nobody chose that
    // database, so refuse before connecting rather than acting on an accident.
    if (!splitMongoUri(process.env.MONGODB_URI).dbName) {
      throw new Error(
        `Refusing to use MONGODB_URI="${process.env.MONGODB_URI}": it names no database, so the `
          + 'driver would fall back to its default ("test") and this setup would drop that. '
          + 'Give the URI an explicit database path.',
      );
    }

    const connection = await MongoClient.connect(process.env.MONGODB_URI);
    const db = connection.db();

    // Never drop a database that is not recognizably a test database. This branch drops
    // whatever MONGODB_URI points at, and that variable is not always a test DB: a running
    // `lt dev` session exports it pointing at the project's DEVELOPMENT database, so without
    // this guard, running the suite from that shell silently wipes the developer's data.
    //
    // This is the ONE drop site with no second condition — the sweep below and the reporter's
    // collection both additionally require isStaleTestDb(), i.e. the name must belong to this
    // project's own base. So the name is the only evidence here, and it gets the strictest
    // reading available: the marker must be a delimited segment AND the name must not carry an
    // environment suffix (`-local`, `-prod`, …). Without the second half, a project slug that
    // legitimately contains `ci` (Corporate Identity) or `test` (an exam product) still lost its
    // `lt dev` database.
    if (!isDroppableTestDb(db.databaseName)) {
      await connection.close();
      throw new Error(
        `Refusing to dropDatabase("${db.databaseName}"): not a recognized disposable test database `
          + `(needs a delimited e2e/ci/test/acctest segment — ${SAFE_TEST_DB_PATTERN} — and must not `
          + `carry an environment suffix — ${NON_DISPOSABLE_DB_PATTERN}). `
          + 'MONGODB_URI must point at a disposable test database.',
      );
    }

    await db.dropDatabase();
    console.info(`Dropped externally configured test database: ${db.databaseName}`);
    await connection.close();
    return;
  }

  const { dbName, query, serverUri } = splitMongoUri(envConfig.mongoose.uri);

  // 0. Filesystem sweep — remove upload-test artifacts (`tests/*.txt`, `*.bin`,
  // `*.png`) left behind by aborted file-upload specs. Same philosophy as the DB
  // sweep below: restarting the suite restores a clean state no matter how the
  // previous run died. No tracked fixtures match these patterns (git-verified:
  // `git ls-files tests | grep -iE '\.(png|txt|bin)$'` is empty — five 16-byte
  // `avatar-*.png` leftovers used to be tracked and were removed with the
  // extension); `pnpm run test:cleanup` remains for manual use and matches the
  // same three extensions.
  //
  // The specs themselves no longer write here at all — they stage fixtures in an
  // `mkdtemp` directory under `os.tmpdir()` — so this is now a net for older
  // branches and for anything that regresses to writing into `tests/`.
  try {
    // vitest runs globalSetup with cwd = project root (config `root: './'`).
    const testsDir = join(process.cwd(), 'tests');
    for (const entry of readdirSync(testsDir)) {
      if (ARTIFACT_EXTENSIONS.some(extension => entry.endsWith(extension)) && entry !== '.gitkeep') {
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
      let guardSkipped = 0;
      for (const { name } of databases) {
        if (!isStaleTestDb(name, dbName)) {
          continue;
        }
        if (!SAFE_TEST_DB_PATTERN.test(name)) {
          guardSkipped++;
          continue;
        }
        await connection.db(name).dropDatabase();
        swept.push(name);
      }
      if (swept.length > 0) {
        console.info(`Startup sweep: dropped ${swept.length} stale test database(s): ${swept.join(', ')}`);
      }
      if (guardSkipped > 0) {
        // Stale by ownership, refused by name. Under the naming contract documented at
        // SAFE_TEST_DB_PATTERN this is zero; a non-zero count means this project's base name
        // violates it and its databases now accumulate with nothing collecting them. Silence
        // here is exactly how that goes unnoticed, so it gets a line.
        console.warn(
          `Startup sweep: ${guardSkipped} stale database(s) skipped by the safety guard — `
            + `"${dbName}" needs a delimited e2e/ci/test/acctest segment for cleanup to work.`,
        );
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

  // 2. Infrastructure containers (Redis + S3-compatible store).
  //
  // Four suites talk to the real thing and fail loudly when it is missing, which
  // is correct — but it used to mean a developer had to read the failure and
  // paste a docker command, while only CI provisioned them. Starting them here
  // makes `pnpm test` work the same way in both places. Idempotent, so a running
  // container is reused rather than restarted.
  //
  // Never fatal: a machine without Docker still runs every suite that needs no
  // infrastructure, and the four that do report their own actionable error.
  // CI sets LT_TEST_INFRA=0 because its workflow provisions the containers.
  try {
    await startTestInfra();
  } catch (error) {
    console.warn(
      `Test infrastructure not started: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  // 3. Machine-wide run governor — wait for a free e2e slot before spawning forks.
  releaseRunSlot = await acquireRunSlot();

  // 4. Unique per-run database.
  const runDbName = `${dbName}-run-${Date.now()}-p${process.pid}`;
  process.env.MONGODB_URI = `${serverUri}/${runDbName}${query}`;
  console.info(`Test database for this run: ${runDbName}`);
}

export async function teardown() {
  releaseRunSlot?.();
  releaseRunSlot = undefined;
}
