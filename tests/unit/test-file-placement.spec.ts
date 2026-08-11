import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Unit tests live in `tests/unit/`, never beside the code in `src/`.
 *
 * This is not a style preference. `src/` is this framework's SHIPPING ARTIFACT:
 *
 * - `package.json` → `files` includes all of `src` recursively, so every file there goes into the
 *   npm tarball. Before this rule was enforced, 22 `.spec.ts` files shipped to consumers.
 * - Vendor-mode consumers copy `src/core/` into their own tree as first-class project code, and
 *   the CLI's `convertCloneToVendored` applies no spec filter — so those tests became part of
 *   THEIR codebase, re-delivered on every core update, run by nobody.
 *
 * Co-location is a fine default for an application. For a library whose `src/` is the delivery,
 * the separation wins. The runner's include glob (`vitest.include-globs.ts`) no longer even looks
 * at `src/`, so a spec placed there would not run — this test makes that visible as a failure
 * rather than as silently skipped coverage.
 */
const ROOT = join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['.git', 'coverage', 'dist', 'node_modules']);

function collectSpecs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        collectSpecs(join(dir, entry.name), acc);
      }
    } else if (/\.(spec|test)\.ts$/.test(entry.name)) {
      acc.push(relative(ROOT, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return acc;
}

describe('test file placement', () => {
  it('keeps src/ free of test files, so none ship to consumers', () => {
    const stray = collectSpecs(join(ROOT, 'src'));

    expect(
      stray,
      'Test files under src/ ship in the npm tarball and are copied into vendor-mode consumer '
        + 'projects. Move them to tests/unit/ (e2e specs to tests/).',
    ).toEqual([]);
  });

  it('has unit specs to run at all — guards against an empty glob', () => {
    // A placement rule that passes because nothing is left would be worse than
    // the problem it solves.
    expect(collectSpecs(join(ROOT, 'tests', 'unit')).length).toBeGreaterThan(50);
  });
});
