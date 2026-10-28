/**
 * Single source of truth for the two vitest runners' `include` globs.
 *
 * Imported by `vitest.config.mts`, `vitest-e2e.config.mts` AND
 * `tests/unit/test-file-routing.spec.ts`. The routing guard reads the exact arrays the runners
 * use, so it can never drift from them — without importing (and thereby evaluating) the full
 * config modules, which would instantiate the swc plugin and, under `CHECK_LOW_RESOURCE`, write
 * to stderr from inside the unit run.
 *
 * Which runner claims a file is decided purely by its filename; see `.claude/rules/testing.md`.
 */

/**
 * Unit runner (`vitest.config.mts`): no MongoDB, no globalSetup.
 *
 * `tests/unit/**` ONLY — deliberately not `src/**`.
 *
 * `src/` is this framework's shipping artifact, not just its source: `package.json` → `files`
 * includes all of `src` recursively, so anything there lands in the npm tarball, and vendor consumers copy
 * `src/core/` into their own tree as first-class project code (the CLI's `convertCloneToVendored`
 * applies no spec filter). A co-located spec therefore ships to every consumer as a test file they
 * neither run nor maintain, and it re-appears on every core update.
 *
 * Co-location is a good default for an application. For a library whose `src/` IS the delivery,
 * the separation wins — hence one place for unit tests, enforced by `test-file-placement.spec.ts`.
 */
export const UNIT_TEST_INCLUDE = ['tests/unit/**/*.spec.ts'];

/**
 * E2E runner (`vitest-e2e.config.mts`): mongod + globalSetup. Story tests are e2e-grade.
 *
 * `tests/**` is intentionally broad on the `.e2e-spec.ts` suffix. Type-only tests under
 * `tests/types/` MUST keep the `.type-test.ts` suffix (compiled by `pnpm run test:types`, never
 * executed) — a `tests/types/*.e2e-spec.ts` would be picked up here and run against the DB. The
 * routing guard (`tests/unit/test-file-routing.spec.ts`) already treats `tests/types/` as
 * non-executable, so a misnamed type test surfaces as an orphan rather than an accidental e2e run.
 */
export const E2E_TEST_INCLUDE = ['tests/**/*.e2e-spec.ts', 'tests/stories/**/*.story.test.ts'];

/**
 * The SQL engine the `postgres` project runs the whole e2e suite on — the default engine (plan §3.10). The persistence
 * matrix proves every engine; the IAM suites below run on the other two as well.
 */
export const POSTGRES_E2E_ENGINE = 'typeorm';

/**
 * The e2e suites the `postgres` project does NOT run, each with the reason. Every other e2e file runs a second time
 * there, with PostgreSQL as the default data source and a database of its own (`tests/postgres-file.setup.ts`).
 * `tests/unit/postgres-e2e-coverage.spec.ts` keeps this list honest: an entry names an existing suite and one of two
 * reasons, nothing else.
 *
 * - `MONGODB-ONLY:` the suite checks a MongoDB mechanism (Mongoose plugins, GridFS, the native driver, the 12.0.0 lock
 *   documents) against MongoDB itself. What it guards on PostgreSQL is proven elsewhere, named in the reason.
 * - `OWN-DATABASES:` the suite picks its databases itself (a parity matrix with its own PostgreSQL column, or a
 *   database it creates); a run with PostgreSQL as the default source would only repeat it.
 *
 * An entry is a claim about the suite, not a way to get the run green: a suite that fails on PostgreSQL because it
 * reads MongoDB directly belongs on the neutral helpers (`tests/helpers/iam-test-db.ts`, `ai-test-stores.ts`), not here.
 */
export const POSTGRES_E2E_EXCLUDED: Readonly<Record<string, string>> = {
  'tests/core-module-parity.e2e-spec.ts':
    'OWN-DATABASES: assembles the core modules on MongoDB, PostgreSQL, MySQL and MariaDB itself',
  'tests/file-storage-http-parity.e2e-spec.ts':
    'OWN-DATABASES: the file parity matrix routes the metadata to MongoDB and to PostgreSQL itself',
  'tests/file-storage-parity.e2e-spec.ts':
    'OWN-DATABASES: the file parity matrix routes the metadata to MongoDB and to PostgreSQL itself',
  'tests/filesystem-storage.e2e-spec.ts':
    'MONGODB-ONLY: FilesystemFileHelper against the native `filesystem-files` collection (index, layout); on PostgreSQL the file parity matrix covers the filesystem driver',
  'tests/migrate/mongo-state-store.e2e-spec.ts':
    'MONGODB-ONLY: the MongoDB migration state store; tests/migrate/sql-state-store.e2e-spec.ts is its PostgreSQL counterpart',
  'tests/migrate/sql-state-store.e2e-spec.ts':
    'OWN-DATABASES: creates the PostgreSQL, MySQL and MariaDB databases it migrates',
  'tests/migrate/upload-file-to-gridfs.e2e-spec.ts':
    'MONGODB-ONLY: the GridFS upload helper of the migration utilities',
  'tests/mongoose-cast-error.e2e-spec.ts':
    'MONGODB-ONLY: the Mongoose CastError filter; a SQL store answers a malformed id itself (persistence matrix)',
  'tests/mongoose-plugins.e2e-spec.ts':
    'MONGODB-ONLY: the Mongoose plugins; their policies run in the SQL store (persistence matrix)',
  'tests/persistence-lock-formats.e2e-spec.ts':
    'MONGODB-ONLY: the 12.0.0 lock documents an older replica reads in a rolling deploy',
  'tests/persistence-lock-store.e2e-spec.ts':
    'OWN-DATABASES: runs the lock store contract on MongoDB, PostgreSQL, MySQL and MariaDB itself',
  'tests/persistence-mysql-executor.e2e-spec.ts': 'OWN-DATABASES: creates the MySQL and MariaDB databases it tests',
  'tests/persistence-mysql-schema.e2e-spec.ts': 'OWN-DATABASES: creates the MySQL and MariaDB databases it tests',
  'tests/persistence-mysql-wiring.e2e-spec.ts': 'OWN-DATABASES: creates the MySQL and MariaDB databases it boots on',
  'tests/persistence-parity.e2e-spec.ts':
    'OWN-DATABASES: the persistence matrix runs MongoDB and every PostgreSQL, MySQL and MariaDB engine itself',
  'tests/persistence-sql-executor.e2e-spec.ts': 'OWN-DATABASES: creates the PostgreSQL databases it tests',
  'tests/persistence-sql-schema.e2e-spec.ts': 'OWN-DATABASES: creates the PostgreSQL databases it tests',
  'tests/persistence-sql-store.e2e-spec.ts': 'OWN-DATABASES: creates the PostgreSQL databases it tests',
  'tests/persistence-sql-where.e2e-spec.ts':
    'OWN-DATABASES: creates the PostgreSQL, MySQL and MariaDB databases it tests',
  'tests/persistence-sql-wiring.e2e-spec.ts': 'OWN-DATABASES: creates the PostgreSQL databases it boots on',
  'tests/persistence-tenant-row-check.e2e-spec.ts':
    'MONGODB-ONLY: the tenant row check of the Mongoose plugin hooks; the SQL store has its own (persistence matrix)',
};

/**
 * The IAM suites that run once more per further SQL engine, with PostgreSQL as the default data source (projects
 * `iam-sql-<engine>` in `vitest-e2e.config.mts`): Better-Auth's stories (sign-in, 2FA, passkey, sessions), the sync
 * between legacy and IAM (password, email, name), the AI and MCP OAuth suites, and the security specs that pin what
 * must hold on every database (server-managed fields stay `input: false`, sign-in CSRF). Better-Auth runs its own
 * adapter on each engine's driver pool, which is why these suites see every engine and not only the default one the
 * `postgres` project uses.
 */
export const IAM_SQL_TEST_INCLUDE = [
  'tests/stories/better-auth-*.story.test.ts',
  'tests/stories/better-auth-migration-status.e2e-spec.ts',
  'tests/stories/better-auth-privilege-escalation.e2e-spec.ts',
  'tests/ai.e2e-spec.ts',
  'tests/ai-mcp-oauth.e2e-spec.ts',
  'tests/ai-mcp-oauth-tenant.e2e-spec.ts',
  'tests/better-auth-signin-csrf.e2e-spec.ts',
  'tests/better-auth-storage-paths.e2e-spec.ts',
  'tests/stories/bidirectional-auth-sync.e2e-spec.ts',
];

/** The SQL engines the IAM suites run on besides the `postgres` project's default engine (plan §3.10) */
export const IAM_SQL_ENGINES = ['kysely', 'drizzle'] as const;
