import { createHash } from 'crypto';
import { MongoClient } from 'mongodb';

/**
 * Matches the per-run database names created by tests/global-setup.ts,
 * e.g. `nest-server-e2e-run-1783062000000-p12345`.
 * Capture groups: [1] start timestamp (ms), [2] PID of the vitest main process.
 */
export const RUN_DB_PATTERN = /-run-(\d+)-p(\d+)$/;

/**
 * A database name MUST match this before anything here is willing to drop it.
 *
 * The safety net for a MONGODB_URI that does not point where the test setup
 * assumes: a running `lt dev` session exports it pointing at the project's
 * DEVELOPMENT database, so without this guard a test run started from that
 * shell would silently wipe the developer's data.
 *
 * The marker must be a whole SEGMENT of the name, not a substring anywhere in
 * it. The unanchored form this replaced was far too permissive: "ci" alone
 * occurs inside soCIal, speCIal, finanCIal, invoiCIng, priCIng and muniCIpal,
 * and "test" inside testimonials, latest and contest. A project named e.g.
 * `social-hub` therefore had its DEVELOPMENT database accepted as a disposable
 * test database — exactly the data loss this guard exists to prevent, given
 * that `lt dev` exports the URI pointing at that very database.
 *
 * NOT exploitable in THIS repo — `nest-server-local` carries no marker even as a
 * substring, so the old pattern refused it too. The exposure is in the copies of
 * this file in starter-derived projects, whose slug is arbitrary. That is what
 * the spec's `social-hub-local` / `pricing-portal-local` cases stand for; do not
 * read them as nest-server names and conclude the guard was never needed.
 *
 * The anchoring turns this into a NAMING CONTRACT on the base database name: the
 * marker must be delimited by `-`/`_` or a string boundary. `nest-server-e2e`
 * and `nest-server-ci` satisfy it; a name like `shope2e` or `app-e2edb` would
 * not, and its databases would then never be collected (see the skip counters in
 * the sweep and in `onTestRunEnd`, which exist to make that visible).
 *
 * `acctest` is a separate alternative BECAUSE of the anchoring: `test` no longer
 * matches inside it (no delimiter precedes the `test`). It was redundant under
 * the old pattern; deleting it as "redundant" now would silently stop
 * acceptance-test databases from ever being collected.
 *
 * Known residual accepts, by design: a name whose marker is a legitimate whole
 * segment stays droppable — `ci-artifacts`, `latest-ci`, `test-data`. A name
 * heuristic cannot tell those apart from a test database. This is why the
 * externally-set-URI path additionally applies NON_DISPOSABLE_DB_PATTERN below,
 * and why per-name rules belong there rather than in this pattern.
 */
export const SAFE_TEST_DB_PATTERN = /(^|[-_])(e2e|ci|test|acctest)([-_]|$)/i;

/**
 * Environment suffixes that mark a database as NOT disposable, whatever else its
 * name says. Applied ON TOP of SAFE_TEST_DB_PATTERN by `isDroppableTestDb()`.
 *
 * Why this exists: SAFE_TEST_DB_PATTERN is a name heuristic, and a project slug
 * may legitimately carry one of its markers as a whole word. In this shop both
 * are realistic — `ci` is the ordinary German abbreviation for *Corporate
 * Identity* (`ci-relaunch`, `ci-portal`), and `test` is a product noun for an
 * exam or assessment (`online-test`). `lt dev up` names the developer's database
 * `<slug>-local` and exports MONGODB_URI at it, so `ci-portal-local` reached the
 * one drop site that has NO second condition — see `tests/global-setup.ts`.
 *
 * Deliberately NOT applied to the sweep paths: those already require
 * `isStaleTestDb(name, base)`, i.e. the name must belong to this project's own
 * base, and adding a second refusal there could only turn a collected database
 * into a leaked one.
 */
export const NON_DISPOSABLE_DB_PATTERN
  = /(^|[-_])(local|dev|develop|development|prod|production|staging|stage|live)([-_]|$)/i;

/**
 * May this database be dropped by a path that has no other condition to lean on?
 *
 * Use this — not SAFE_TEST_DB_PATTERN alone — wherever the name is the ONLY
 * evidence available, i.e. for an externally supplied MONGODB_URI.
 */
export function isDroppableTestDb(name: string): boolean {
  return SAFE_TEST_DB_PATTERN.test(name) && !NON_DISPOSABLE_DB_PATTERN.test(name);
}

/**
 * Age limit for stale run databases. Normally staleness is detected via a dead
 * PID; this cap only exists for the rare case of PID recycling (the old PID now
 * belongs to an unrelated long-lived process, so the DB would never be
 * collected by the PID check alone).
 */
const STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Split a MongoDB URI into server part, database name, and query string.
 * `mongodb://127.0.0.1/foo?bar=1` → { dbName: 'foo', query: '?bar=1', serverUri: 'mongodb://127.0.0.1' }
 */
export function splitMongoUri(uri: string): { dbName: string; query: string; serverUri: string } {
  // The database is the path segment AFTER the authority, which is why this anchors on the
  // scheme instead of scanning for the last `/`. The previous greedy form (`^(.*)\/([^/?]+)…`)
  // got two cases wrong: `mongodb://127.0.0.1` reported the HOST as the database name, hiding
  // the fact that the URI names none at all (the driver then silently falls back to its default
  // database, `test`); and an option value containing a slash — `?tlsCAFile=/etc/ca.pem` —
  // reported `ca.pem`. Both matter: global-setup.ts refuses to drop a database the URI never
  // named, and it can only do that if an absent name reads as absent.
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/?]*)(?:\/([^/?]*))?(\?.*)?$/i);
  if (!match) {
    return { dbName: '', query: '', serverUri: uri };
  }
  return { dbName: match[2] || '', query: match[3] || '', serverUri: match[1] };
}

/**
 * Derive an additional per-run database URI for tests that need their own,
 * separate database (e.g. multi-tenancy or plugin isolation). NEVER hardcode a
 * fixed database name in a test — fixed names are shared between concurrent
 * runs (mutual interference) and their leftovers are collected by nothing.
 *
 * The name is derived from this run's unique database, so the db-lifecycle
 * cleanup collects it automatically (success → dropped with the run; aborted
 * run → collected by the next successful run via the dead-PID rule).
 *
 * MongoDB caps database names at 63 characters — longer derived names are
 * truncated and made unique again with a short deterministic hash.
 */
export function deriveTestDbUri(suffix: string): string {
  const baseUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1/nest-server-e2e';
  const { dbName, query, serverUri } = splitMongoUri(baseUri);
  let name = `${dbName}-${suffix}`;
  if (name.length > 63) {
    const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
    name = `${name.slice(0, 54)}-${hash}`;
  }
  return `${serverUri}/${name}${query}`;
}

/**
 * Is a process with this PID currently running?
 *
 * Caveat worth knowing before trusting a `false`: `process.kill(pid, 0)` throws
 * EPERM for a LIVE process owned by another user, and this catch cannot tell
 * that apart from ESRCH ("no such process"). On a shared machine another user's
 * running e2e database is therefore classified stale. Harmless here because the
 * name guard still has to agree, but it is the reason this must never become the
 * sole condition for a drop.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is `name` a leftover test database of the given base name that no live run owns?
 *
 * Shared between the end-of-run cleanup (reporter below) and the START-of-run sweep in
 * tests/global-setup.ts. The startup sweep is what makes cleanup survive every abnormal
 * end: a SIGKILLed run (check.mjs watchdog escalation), a run started with an explicit
 * `--reporter` CLI flag (which replaces the config reporters, including this one), or a
 * crashed terminal — none of them can clean up after themselves, so the NEXT run cleans
 * up BEFORE it starts instead.
 *
 * Callers must additionally apply SAFE_TEST_DB_PATTERN before dropping.
 */
export function isStaleTestDb(name: string, base: string, now: number = Date.now()): boolean {
  if (name === base) {
    // Legacy fixed-name test DB (pre unique-name scheme) — nothing writes it anymore.
    return true;
  }
  if (name.startsWith(`${base}-run-`)) {
    // Another run's DB (or a DB derived from it): stale when its creating
    // process is dead or it exceeded the age cap.
    const match = name.match(/-run-(\d+)-p(\d+)/);
    return match ? !isPidAlive(Number(match[2])) || now - Number(match[1]) > STALE_MAX_AGE_MS : false;
  }
  // Legacy pre-unique-scheme leftovers carrying a trailing timestamp,
  // e.g. `<base>-setup-1783062745355` from aborted runs of older code.
  // The 1h age guard protects a concurrently running old-code suite.
  const legacy = name.match(new RegExp(`^${escapeRegExp(base)}-.+-(\\d{13})$`));
  return legacy ? now - Number(legacy[1]) > 60 * 60 * 1000 : false;
}

/**
 * Vitest reporter managing the lifecycle of per-run test databases
 * (created by tests/global-setup.ts):
 *
 * - Run PASSED → drop this run's database immediately AND collect leftovers:
 *   run databases whose creating process is dead (crashed or failed earlier
 *   runs), run databases older than 7 days (PID-recycling fallback), and the
 *   legacy fixed-name database from before the unique-name scheme.
 * - Run FAILED or was interrupted → KEEP this run's database so the state can
 *   be inspected for debugging; the next successful run removes it.
 *
 * Cleanup is strictly best-effort: any error here must never affect the test
 * exit code. Note: running vitest with an explicit `--reporter` CLI flag
 * replaces the config reporters (including this one) — leftovers from such
 * runs are collected by the next regular successful run.
 */
export default class DbLifecycleReporter {
  async onTestRunEnd(
    _testModules: unknown,
    unhandledErrors: readonly unknown[],
    reason: 'failed' | 'interrupted' | 'passed',
  ): Promise<void> {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      return;
    }
    const { dbName, serverUri } = splitMongoUri(uri);
    if (!RUN_DB_PATTERN.test(dbName)) {
      // Externally pinned database (e.g. CI service container) — not managed here.
      return;
    }

    if (reason !== 'passed' || unhandledErrors.length > 0) {
      // The actual test data lives in the per-worker fork databases (`${dbName}-w<N>`, created in
      // tests/setup.ts), NOT in `${dbName}` itself. COMPACT on purpose: this block prints inside
      // the failure output, and check.mjs shows only the LAST ~40 lines of a failed step — a
      // full 27-line DB listing used to flood that window and push the actual test failure out
      // of sight. The pattern + count is enough to connect to the right database.
      let forkCount = 0;
      try {
        const connection = await MongoClient.connect(uri);
        try {
          const { databases } = await connection.db().admin().listDatabases({ nameOnly: true });
          forkCount = databases.filter((d) => d.name.startsWith(`${dbName}-w`)).length;
        } finally {
          await connection.close();
        }
      } catch {
        /* count stays 0 — the pattern line below is still correct */
      }
      console.info(
        `\n⚠ Test databases kept for debugging: ${serverUri}/${dbName}-w<N>` +
          (forkCount > 0 ? ` (${forkCount} databases, one per worker fork + derived)` : '') +
          '\n  Removed automatically when the next test run starts (startup sweep).',
      );
      return;
    }

    try {
      const connection = await MongoClient.connect(uri);
      try {
        const dropped: string[] = [];
        await connection.db(dbName).dropDatabase();
        dropped.push(dbName);

        const base = dbName.replace(RUN_DB_PATTERN, '');
        const { databases } = await connection.db().admin().listDatabases({ nameOnly: true });
        let guardSkipped = 0;
        for (const { name } of databases) {
          if (name === dbName) {
            continue;
          }
          // DBs derived from THIS run's name (per-worker `-w<N>` and their derived
          // suffixes) — the run is over, they go regardless of PID/age.
          const stale = name.startsWith(`${dbName}-`) || isStaleTestDb(name, base);
          if (!stale) {
            continue;
          }
          // Belt and braces: never drop anything that is not recognizably a test database.
          if (!SAFE_TEST_DB_PATTERN.test(name)) {
            guardSkipped++;
            continue;
          }
          await connection.db(name).dropDatabase();
          dropped.push(name);
        }
        console.info(`Test database cleanup: dropped ${dropped.join(', ')}`);
        if (guardSkipped > 0) {
          // A stale-looking database the name guard refused. Under the naming contract
          // documented at SAFE_TEST_DB_PATTERN this should be zero — a non-zero count means
          // those databases will never be collected, so say so rather than leaking silently.
          console.warn(
            `Test database cleanup: ${guardSkipped} stale database(s) skipped by the safety guard `
              + `(name lacks a delimited e2e/ci/test/acctest segment) — these will accumulate.`,
          );
        }
      } finally {
        await connection.close();
      }
    } catch (error) {
      console.warn(`Test database cleanup skipped: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
