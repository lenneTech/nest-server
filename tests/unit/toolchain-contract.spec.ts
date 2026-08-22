import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The lint/typecheck contract, asserted structurally.
 *
 * `pnpm run check` runs `oxlint --fix` BEFORE `typecheck:tests` and `build`. That ordering makes the
 * linter capable of INTRODUCING a compile error: `unicorn/no-array-reverse` rewrites `.reverse()`
 * into `.toReversed()`, which needs an ES2023 lib. Under the base lib (es2022, inherited from
 * `target`) the rewritten file no longer compiles — so a green run could turn itself red in a file
 * nobody edited, and the only visible cause was a diff the developer did not write.
 *
 * The fix has two halves, and BOTH are load-bearing. Removing either one re-arms the trap in one
 * of the two directories, so each is pinned here:
 *
 *  1. `tsconfig.tests.json` raises `lib` to ES2023 — tests and everything under `scripts/` ship to
 *     nobody, so
 *     they may use the API the linter prefers.
 *  2. `.oxlintrc.json` turns the rule OFF for `src/**` — shipped source may NOT, because vendor-mode
 *     consumers copy `src/core/**` into their own tree and compile it with the starter's tsconfig
 *     (target es2022, no `lib`). A linter that rewrites framework source into ES2023 would break
 *     them at a distance, in a repo whose CI never runs.
 *
 * A structural test rather than an end-to-end one on purpose: the failure this guards is a
 * CONFIGURATION drift, and re-running the whole toolchain to observe it would cost minutes to learn
 * something two file reads answer.
 */
describe('toolchain lint/typecheck contract', () => {
  const root = join(__dirname, '..', '..');

  /** Strip comments so a JSONC config (`.oxlintrc.json`, `tsconfig*.json`) parses. */
  const readJsonc = (relative: string): any => {
    const raw = readFileSync(join(root, relative), 'utf8');
    const withoutComments = raw
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(withoutComments);
  };

  it('lets the TEST suites use the ES2023 array methods oxlint rewrites into', () => {
    const testsConfig = readJsonc('tsconfig.tests.json');
    expect(testsConfig.compilerOptions.lib).toContain('ES2023');
  });

  it('actually compiles and runs `toReversed()` under that lib', () => {
    // Compile-time half: this line does not type-check if `lib` regresses below ES2023, so
    // `pnpm run typecheck:tests` fails before any assertion runs.
    expect([1, 2, 3].toReversed()).toEqual([3, 2, 1]);
  });

  it('keeps the ES2023 rewrite OUT of shipped source, which vendor consumers compile as es2022', () => {
    const oxlintConfig = readJsonc('.oxlintrc.json');
    const srcOverride = (oxlintConfig.overrides ?? []).find((override: any) =>
      (override.files ?? []).includes('src/**'),
    );

    expect(srcOverride, 'no `src/**` override in .oxlintrc.json').toBeDefined();
    expect(srcOverride.rules['unicorn/no-array-reverse']).toBe('off');
  });

  it('does not raise `lib` in the BASE tsconfig, which vendored source inherits', () => {
    // The base config is what `tsconfig.build.json` (and therefore the published `dist/`) extends.
    // Raising it here would silently permit an ES2023 API in `src/`, which is the exact thing the
    // `src/**` override above exists to prevent.
    const baseConfig = readJsonc('tsconfig.json');
    expect(baseConfig.compilerOptions.lib).toBeUndefined();
    expect(baseConfig.compilerOptions.target).toBe('es2022');
  });
});
