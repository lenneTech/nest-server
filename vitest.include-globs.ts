/**
 * Single source of truth for the two vitest runners' `include` globs.
 *
 * Imported by `vitest.config.ts`, `vitest-e2e.config.ts` AND
 * `tests/unit/test-file-routing.spec.ts`. The routing guard reads the exact arrays the runners
 * use, so it can never drift from them — without importing (and thereby evaluating) the full
 * config modules, which would instantiate the swc plugin and, under `CHECK_LOW_RESOURCE`, write
 * to stderr from inside the unit run.
 *
 * Which runner claims a file is decided purely by its filename; see `.claude/rules/testing.md`.
 */

/** Unit runner (`vitest.config.ts`): no MongoDB, no globalSetup. */
export const UNIT_TEST_INCLUDE = ['src/**/*.spec.ts', 'tests/unit/**/*.spec.ts'];

/**
 * E2E runner (`vitest-e2e.config.ts`): mongod + globalSetup. Story tests are e2e-grade.
 *
 * `tests/**` is intentionally broad on the `.e2e-spec.ts` suffix. Type-only tests under
 * `tests/types/` MUST keep the `.type-test.ts` suffix (compiled by `pnpm run test:types`, never
 * executed) — a `tests/types/*.e2e-spec.ts` would be picked up here and run against the DB. The
 * routing guard (`tests/unit/test-file-routing.spec.ts`) already treats `tests/types/` as
 * non-executable, so a misnamed type test surfaces as an orphan rather than an accidental e2e run.
 */
export const E2E_TEST_INCLUDE = ['tests/**/*.e2e-spec.ts', 'tests/stories/**/*.story.test.ts'];
