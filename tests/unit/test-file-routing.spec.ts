/**
 * Unit Tests: every test file is claimed by exactly one vitest runner.
 *
 * The two runners select files by filename pattern:
 * - `vitest.config.ts`      → `src/**\/*.spec.ts`, `tests/unit/**\/*.spec.ts`
 * - `vitest-e2e.config.ts`  → `tests/**\/*.e2e-spec.ts`, `tests/stories/**\/*.story.test.ts`
 *
 * Narrow patterns are what keep unit tests out of the mongod-backed e2e runner, but they also
 * mean a file whose name matches NEITHER pattern runs nowhere: `tests/stories/foo.test.ts`
 * (missing the `.story.` infix), `tests/integration/bar.spec.ts` (outside `tests/unit/`) or
 * `tests/unit/baz.test.ts` (wrong suffix) all pass CI green while testing nothing.
 *
 * This spec closes that hole from both sides: no test file may be orphaned, and none may be
 * claimed twice (running a unit test inside the e2e runner is the bug that motivated the split).
 * The patterns come from `vitest.include-globs.ts`, the same module both configs import for their
 * `include`, so this check can never drift from what the runners actually use — and reading the
 * arrays directly avoids importing the full config modules (which would evaluate the swc plugin).
 */
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { E2E_TEST_INCLUDE, UNIT_TEST_INCLUDE } from '../../vitest.include-globs';

const ROOT = join(__dirname, '..', '..');

/** Directories that never contain test files, and are expensive or pointless to walk. */
const SKIP_DIRS = new Set(['.git', 'coverage', 'dist', 'node_modules', 'public']);

/**
 * Type-only tests live under `tests/types/` and are compiled by `pnpm run test:types`
 * (`tsc --noEmit`), never executed by vitest. Excluding the whole directory (rather than a
 * filename suffix) keeps this load-bearing: even a `.spec.ts` misplaced there is correctly
 * treated as non-executable instead of being reported as an orphan.
 */
const TYPE_TEST_DIR = 'tests/types/';

/**
 * A file that a reader would take for an executable test suite. Covers all three suffixes in use:
 * `.spec.ts` (unit), `-spec.ts` (`*.e2e-spec.ts`) and `.test.ts` (`*.story.test.ts`).
 */
function isTestFile(relativePath: string): boolean {
  if (relativePath.startsWith(TYPE_TEST_DIR)) {
    return false;
  }
  return (
    relativePath.endsWith('.spec.ts') || relativePath.endsWith('-spec.ts') || relativePath.endsWith('.test.ts')
  );
}

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectFiles(join(dir, entry.name), acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(relative(ROOT, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return acc;
}

/**
 * Minimal glob → RegExp for the shapes the vitest `include` patterns actually use here:
 * a `**` segment (zero or more path segments) and `*` (any run of characters within one
 * segment). Everything else is matched literally.
 */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      source += '(?:[^/]+/)*';
      i += 2;
    } else if (glob[i] === '*') {
      source += '[^/]*';
    } else {
      source += glob[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

const RUNNERS = [
  { name: 'unit (vitest.config.ts)', patterns: UNIT_TEST_INCLUDE },
  { name: 'e2e (vitest-e2e.config.ts)', patterns: E2E_TEST_INCLUDE },
].map(runner => ({ ...runner, matchers: runner.patterns.map(globToRegExp) }));

function claimingRunners(file: string): string[] {
  return RUNNERS.filter(runner => runner.matchers.some(re => re.test(file))).map(runner => runner.name);
}

describe('Test file routing', () => {
  const testFiles = [...collectFiles(join(ROOT, 'src')), ...collectFiles(join(ROOT, 'tests'))].filter(isTestFile);

  it('should find the repository test files', () => {
    // Guards against a broken directory walk silently making every assertion below vacuous.
    expect(testFiles.length).toBeGreaterThan(50);
  });

  it('should have every test file claimed by exactly one runner', () => {
    const orphaned = testFiles.filter(file => claimingRunners(file).length === 0);
    const duplicated = testFiles.filter(file => claimingRunners(file).length > 1);

    expect(
      { duplicated, orphaned },
      'A test file matched by no runner never executes; one matched by both runs twice. '
        + 'Rename it to fit an include pattern, or widen the pattern in the vitest config.',
    ).toEqual({ duplicated: [], orphaned: [] });
  });

  it('should route unit and e2e suites to their own runner', () => {
    expect(claimingRunners('tests/unit/cookies-cors-config.spec.ts')).toEqual(['unit (vitest.config.ts)']);
    expect(claimingRunners('tests/server.e2e-spec.ts')).toEqual(['e2e (vitest-e2e.config.ts)']);
    expect(claimingRunners('tests/migrate/mongo-state-store.e2e-spec.ts')).toEqual(['e2e (vitest-e2e.config.ts)']);
    expect(claimingRunners('tests/stories/error-code.story.test.ts')).toEqual(['e2e (vitest-e2e.config.ts)']);
  });

  // The exact filename shapes that used to slip through both configs unnoticed.
  it('should reject test filenames that no runner claims', () => {
    expect(claimingRunners('tests/stories/foo.test.ts')).toEqual([]);
    expect(claimingRunners('tests/integration/bar.spec.ts')).toEqual([]);
    expect(claimingRunners('tests/unit/baz.test.ts')).toEqual([]);
  });

  it('should recognize all three executable-suite suffixes', () => {
    expect(isTestFile('tests/unit/cookies-cors-config.spec.ts')).toBe(true);
    expect(isTestFile('tests/ai.e2e-spec.ts')).toBe(true);
    expect(isTestFile('tests/stories/error-code.story.test.ts')).toBe(true);
  });

  it('should treat everything under tests/types as non-executable', () => {
    // Compiled by `pnpm run test:types`, never run by vitest — excluded by directory, so even a
    // misplaced `.spec.ts` there is not reported as an orphan.
    expect(isTestFile('tests/types/better-auth-config.type-test.ts')).toBe(false);
    expect(isTestFile('tests/types/some-helper.spec.ts')).toBe(false);
  });
});
