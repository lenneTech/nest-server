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
 * The IAM suites that run once more per SQL engine, with PostgreSQL as the default data source (projects
 * `iam-sql-<engine>` in `vitest-e2e.config.mts`): Better-Auth's stories (sign-in, 2FA, passkey, sessions), the sync
 * between legacy and IAM (password, email, name), and the security specs that pin what must hold on every database
 * (server-managed fields stay `input: false`, sign-in CSRF).
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

/** The SQL engines every IAM suite runs on (plan §3.10) */
export const IAM_SQL_ENGINES = ['typeorm', 'kysely', 'drizzle'] as const;
