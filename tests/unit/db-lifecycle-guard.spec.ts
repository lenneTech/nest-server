import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveTestDbUri,
  isDroppableTestDb,
  isStaleTestDb,
  NON_DISPOSABLE_DB_PATTERN,
  RUN_DB_PATTERN,
  SAFE_TEST_DB_PATTERN,
  splitMongoUri,
} from '../db-lifecycle.reporter';

/**
 * `SAFE_TEST_DB_PATTERN` is the last thing standing between a test run and a
 * developer's data: `tests/global-setup.ts` drops whatever MONGODB_URI
 * points at, and a running `lt dev` session exports that variable pointing at
 * the project's DEVELOPMENT database.
 *
 * The guard had no test, and was wrong: it matched the marker as a substring
 * ANYWHERE in the name, so `ci` inside "social" and `test` inside "latest" made
 * ordinary project databases look disposable.
 *
 * @regression   SAFE_TEST_DB_PATTERN matched its markers as a substring anywhere in the
 *   database name, so `ci` inside soCIal / speCIal / finanCIal / priCIng / muniCIpal and
 *   `test` inside laTEST / conTEST / TESTimonials made ordinary project databases look
 *   disposable. `lt dev up` exports MONGODB_URI at the project's `<slug>-local` DEVELOPMENT
 *   database, so a developer on such a project who started the e2e suite from that shell had
 *   it dropped — by the guard that exists to prevent exactly that.
 * @seen-failing Restore the unanchored `/(e2e|ci|test|acctest)/i` in
 *   tests/db-lifecycle.reporter.ts — registered as mutation
 *   `safe-test-db-pattern-unanchored` in tests/regression-mutations.json. Nine of the names
 *   in the refuse list below flip to accepted under it.
 */
describe('SAFE_TEST_DB_PATTERN', () => {
  /**
   * Names this project actually generates, plus the shapes a consumer project may use.
   *
   * Every entry here is a name that MUST stay droppable — a refusal does not lose data, but it
   * silently switches cleanup off and the databases accumulate forever.
   */
  const ACCEPTED: [label: string, name: string][] = [
    ['e2e base (config.env.ts)', 'nest-server-e2e'],
    ['ci base (config.env.ts)', 'nest-server-ci'],
    ['per-run (global-setup.ts)', 'nest-server-e2e-run-1783062000000-p12345'],
    // The per-fork database is where the test data actually LIVES (tests/setup.ts appends
    // `-w<poolId>`), and it is what the reporter drops. If a future tightening stranded it,
    // every run would leak one database per worker.
    ['per-fork (tests/setup.ts)', 'nest-server-e2e-run-1783062000000-p12345-w3'],
    ['derived (deriveTestDbUri)', 'nest-server-e2e-run-1783062000000-p12345-w3-tg-ba-resolver'],
    // deriveTestDbUri truncates past 63 chars to `slice(0, 54)` + sha1. The marker sits at
    // index 12, so truncation can never strip it — asserted so that stays true.
    ['derived + truncated', 'nest-server-e2e-run-1787490466261-p82352-w7-tg-ba-reso-c2fb4f5a'],
    ['legacy leftover', 'nest-server-e2e-setup-1783062745355'],
    ['starter base', 'nest-server-starter-e2e'],
    ['underscore separator', 'my_project_test'],
    ['underscore, marker leading', 'e2e_run_1'],
    ['acctest — load-bearing, `test` does not match inside it', 'app-acctest'],
    ['marker as the whole name', 'test'],
    // The `/i` flag and the `_` half of `[-_]` are behaviour somebody could remove while every
    // lowercase-and-hyphen case still passed. Pin both directly.
    ['mixed case (pins the /i flag)', 'MyApp-Test'],
    ['upper case + underscore', 'PROJECT_E2E'],
  ];

  /**
   * Ordinary databases that must NEVER be dropped.
   *
   * The first nine were all ACCEPTED by the unanchored pattern — they are the witnesses that
   * make the registered mutation go red. The entries marked "control" contain no marker under
   * either pattern; they prove nothing about this change and guard only against a future
   * over-broad rewrite. Do not count them when checking which cases went red.
   */
  const REFUSED: [label: string, name: string][] = [
    ['witness — ci inside soCIal', 'social-hub-local'],
    ['witness — ci inside speCIal', 'special-offers'],
    ['witness — ci inside finanCIal', 'lt-financial'],
    ['witness — ci inside invoiCIng', 'invoicing-prod'],
    ['witness — ci inside priCIng', 'pricing-service'],
    ['witness — ci inside muniCIpal', 'municipal-portal'],
    ['witness — test inside TESTimonials', 'kunde-testimonials'],
    ['witness — test inside laTEST', 'latest'],
    ['witness — test inside conTEST', 'contest-app'],
    ['witness — the concrete lt dev data-loss path', 'pricing-portal-local'],
    ['control — no marker under either pattern', 'production'],
    ['control — no marker under either pattern', 'lt-crm-local'],
    // No delimiter before the marker: pins that the anchoring is real and not decorative.
    ['no delimiter — camelCase', 'myAppTest'],
    ['no delimiter — digit suffix', 'test2'],
    ['no delimiter — both sides', 'appTestDb'],
  ];

  it.each(ACCEPTED)('accepts %s: %s', (_label, name) => {
    expect(SAFE_TEST_DB_PATTERN.test(name)).toBe(true);
  });

  it.each(REFUSED)('refuses %s: %s', (_label, name) => {
    expect(SAFE_TEST_DB_PATTERN.test(name)).toBe(false);
  });

  it('is stateless — no /g flag, so repeated .test() cannot desync via lastIndex', () => {
    // A `g` flag here would make every SECOND call on the same name answer false, which on the
    // sweep path means dropping a database the guard just refused.
    expect(SAFE_TEST_DB_PATTERN.global).toBe(false);
    expect(SAFE_TEST_DB_PATTERN.test('nest-server-e2e')).toBe(true);
    expect(SAFE_TEST_DB_PATTERN.test('nest-server-e2e')).toBe(true);
  });

  it('still recognises the per-run databases global-setup.ts generates', () => {
    // Belt and braces: the generated name must satisfy BOTH the run pattern and the safety
    // guard, or a passing run cannot clean up after itself.
    const generated = `nest-server-e2e-run-${Date.now()}-p${process.pid}`;
    expect(RUN_DB_PATTERN.test(generated)).toBe(true);
    expect(SAFE_TEST_DB_PATTERN.test(generated)).toBe(true);
  });
});

/**
 * The second half of the externally-supplied-URI guard.
 *
 * SAFE_TEST_DB_PATTERN is a name heuristic, and a project slug may legitimately carry one of
 * its markers as a whole word — `ci` is the German abbreviation for Corporate Identity, `test`
 * a product noun for an exam. Those names reached the one drop site that has no second
 * condition, and `lt dev` points MONGODB_URI at exactly such a database.
 */
describe('NON_DISPOSABLE_DB_PATTERN / isDroppableTestDb', () => {
  const NOT_DROPPABLE: [label: string, name: string][] = [
    ['ci = Corporate Identity, lt dev database', 'ci-portal-local'],
    ['ci = Corporate Identity, customer project', 'kunde-ci-relaunch-local'],
    ['mixed case still refused', 'CI-Portal-local'],
    ['test = an exam product, in production', 'online-test-prod'],
    ['test = an exam product, lt dev database', 'pruefung-test-local'],
    ['staging deployment', 'api-test-staging'],
    ['live deployment', 'e2e-fixtures-live'],
  ];

  it.each(NOT_DROPPABLE)('refuses %s: %s', (_label, name) => {
    // The name guard alone would accept every one of these.
    expect(SAFE_TEST_DB_PATTERN.test(name)).toBe(true);
    expect(isDroppableTestDb(name)).toBe(false);
  });

  it('does not refuse any name this project generates', () => {
    // The failure mode of an over-broad denylist is a refused cleanup, i.e. silent
    // accumulation. Every generated shape must survive it.
    const generated = [
      'nest-server-e2e',
      'nest-server-ci',
      'nest-server-e2e-run-1783062000000-p12345',
      'nest-server-e2e-run-1783062000000-p12345-w3',
      'nest-server-e2e-run-1783062000000-p12345-w3-tg-ba-resolver',
      'nest-server-e2e-run-1787490466261-p82352-w7-tg-ba-reso-c2fb4f5a',
      'nest-server-e2e-setup-1783062745355',
      'nest-server-starter-e2e',
      'nest-server-starter-ci',
    ];
    for (const name of generated) {
      expect(NON_DISPOSABLE_DB_PATTERN.test(name), `must not be denylisted: ${name}`).toBe(false);
      expect(isDroppableTestDb(name), `must stay droppable: ${name}`).toBe(true);
    }
  });

  it('is stateless, like the pattern it complements', () => {
    expect(NON_DISPOSABLE_DB_PATTERN.global).toBe(false);
    expect(isDroppableTestDb('ci-portal-local')).toBe(false);
    expect(isDroppableTestDb('ci-portal-local')).toBe(false);
  });
});

describe('isStaleTestDb', () => {
  const base = 'nest-server-e2e';
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;

  it('treats the legacy fixed-name database as stale', () => {
    expect(isStaleTestDb(base, base)).toBe(true);
  });

  it('keeps a run database whose creating process is still alive', () => {
    expect(isStaleTestDb(`${base}-run-${Date.now()}-p${process.pid}`, base)).toBe(false);
  });

  it('collects a run database whose creating process is gone', () => {
    // PID 2^22 is above the maximum on Linux and macOS, so it cannot be live.
    expect(isStaleTestDb(`${base}-run-${Date.now()}-p4194304`, base)).toBe(true);
  });

  it('collects a run database past the age cap even when its PID is alive', () => {
    // The PID-recycling fallback: the original process is long gone, but its PID now belongs to
    // an unrelated long-lived process, so the liveness check alone would never collect this.
    const eightDaysAgo = now - 8 * DAY;
    expect(isStaleTestDb(`${base}-run-${eightDaysAgo}-p${process.pid}`, base, now)).toBe(true);
  });

  it('keeps a live-PID run database that is still inside the age cap', () => {
    const sixDaysAgo = now - 6 * DAY;
    expect(isStaleTestDb(`${base}-run-${sixDaysAgo}-p${process.pid}`, base, now)).toBe(false);
  });

  it('collects a legacy trailing-timestamp leftover older than an hour', () => {
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    expect(isStaleTestDb(`${base}-setup-${twoHoursAgo}`, base, now)).toBe(true);
  });

  it('keeps a legacy trailing-timestamp database younger than an hour', () => {
    // Protects a concurrently running suite on older code.
    const tenMinutesAgo = now - 10 * 60 * 1000;
    expect(isStaleTestDb(`${base}-setup-${tenMinutesAgo}`, base, now)).toBe(false);
  });

  it('keeps a malformed run database rather than guessing', () => {
    // `startsWith` succeeds, the inner timestamp/PID match does not — the fall-through must be
    // "leave it alone", never "drop it".
    expect(isStaleTestDb(`${base}-run-garbage`, base, now)).toBe(false);
  });

  it('leaves databases of OTHER projects alone', () => {
    expect(isStaleTestDb('other-project-e2e-run-1-p4194304', base)).toBe(false);
  });

  it('RUN_DB_PATTERN is end-anchored while isStaleTestDb is not — the asymmetry is load-bearing', () => {
    // onTestRunEnd returns early unless MONGODB_URI names a RUN database, so a per-fork name
    // must NOT match RUN_DB_PATTERN. The sweep, in contrast, has to recognise it as stale.
    const perFork = `${base}-run-1783062000000-p4194304-w3`;
    expect(RUN_DB_PATTERN.test(perFork)).toBe(false);
    expect(isStaleTestDb(perFork, base)).toBe(true);
  });
});

describe('splitMongoUri', () => {
  it.each([
    ['mongodb://127.0.0.1/foo', 'foo', '', 'mongodb://127.0.0.1'],
    ['mongodb://127.0.0.1/foo?retryWrites=true', 'foo', '?retryWrites=true', 'mongodb://127.0.0.1'],
    ['mongodb://user:pw@host:27017/bar', 'bar', '', 'mongodb://user:pw@host:27017'],
  ])('splits %s', (uri, dbName, query, serverUri) => {
    expect(splitMongoUri(uri)).toEqual({ dbName, query, serverUri });
  });

  it.each([
    ['mongodb+srv://cluster.example.net/mydb', 'mydb'],
    ['mongodb://host1,host2:27017/rs?replicaSet=rs0', 'rs'],
  ])('splits %s', (uri, dbName) => {
    expect(splitMongoUri(uri).dbName).toBe(dbName);
  });

  it.each([['mongodb://127.0.0.1'], ['mongodb://127.0.0.1/'], ['mongodb://127.0.0.1?w=1']])(
    'reports an EMPTY dbName for %s, which names no database',
    (uri) => {
      // global-setup.ts relies on this to refuse a path-less URI: the driver would otherwise
      // fall back to its default database ("test"), which the name guard happily accepts. The
      // greedy predecessor returned the HOST here, so the refusal could never fire.
      expect(splitMongoUri(uri).dbName).toBe('');
    },
  );

  it('does not mistake a slash inside an option value for the database separator', () => {
    // `?tlsCAFile=/etc/ssl/ca.pem` used to yield dbName "ca.pem".
    expect(splitMongoUri('mongodb://host/appdb?tlsCAFile=/etc/ssl/ca.pem')).toEqual({
      dbName: 'appdb',
      query: '?tlsCAFile=/etc/ssl/ca.pem',
      serverUri: 'mongodb://host',
    });
  });
});

describe('deriveTestDbUri', () => {
  const original = process.env.MONGODB_URI;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MONGODB_URI;
    } else {
      process.env.MONGODB_URI = original;
    }
  });

  it('derives from this run database and keeps the query string', () => {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1/nest-server-e2e-run-1783062000000-p12345?w=1';
    expect(deriveTestDbUri('mt')).toBe(
      'mongodb://127.0.0.1/nest-server-e2e-run-1783062000000-p12345-mt?w=1',
    );
  });

  it('produces a name the cleanup will actually collect', () => {
    // The whole point of deriving rather than hardcoding: the result must satisfy the safety
    // guard, or the extra database leaks on every run.
    process.env.MONGODB_URI = 'mongodb://127.0.0.1/nest-server-e2e-run-1783062000000-p12345';
    const { dbName } = splitMongoUri(deriveTestDbUri('tenant-isolation'));
    expect(SAFE_TEST_DB_PATTERN.test(dbName)).toBe(true);
    expect(isDroppableTestDb(dbName)).toBe(true);
  });

  it('truncates past MongoDB’s 63-character limit without losing the marker', () => {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1/nest-server-e2e-run-1787490466261-p82352-w7';
    const { dbName } = splitMongoUri(deriveTestDbUri('tg-ba-resolver-with-a-very-long-suffix'));
    expect(dbName.length).toBeLessThanOrEqual(63);
    // Truncation keeps `slice(0, 54)`, and the marker sits at index 12 — so a truncated name is
    // still collectable. If the base name ever moved the marker past char 54, cleanup would
    // silently stop collecting derived databases.
    expect(SAFE_TEST_DB_PATTERN.test(dbName)).toBe(true);
  });

  it('is deterministic for the same input', () => {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1/nest-server-e2e-run-1787490466261-p82352-w7';
    const suffix = 'tg-ba-resolver-with-a-very-long-suffix';
    expect(deriveTestDbUri(suffix)).toBe(deriveTestDbUri(suffix));
  });
});
