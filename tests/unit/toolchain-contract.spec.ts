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
/**
 * Strip comments so a JSONC config (`.oxlintrc.json`, `tsconfig*.json`) parses.
 *
 * A SCANNER, not a regex, and the difference is not stylistic. The obvious
 * `raw.replace(/\/\*[\s\S]*?\*\//g, '')` cannot tell a comment from a string literal, and every
 * config read here is full of glob patterns that look exactly like one:
 *
 *   "src/**\/*.spec.ts"   the slash-star-star-slash IS a complete open/close pair  ->  "src*.spec.ts"
 *   "src/**"              opens a comment that runs to the next close ANYWHERE in the file
 *
 * Measured on this repo before the fix: 2783 bytes vanished from `tsconfig.tests.json`, and
 * `.oxlintrc.json` lost an entire `overrides` entry — 4 became 3. Both files still PARSED, so
 * every assertion below was answering questions about a mutilated config, silently. Reported by
 * document-analyzer-13 via nest-server-starter-37, who hit the same shape in the starter.
 *
 * Trailing commas are not handled: JSONC permits them, no config here uses one, and a parse error
 * is a loud failure rather than a quiet wrong answer. Add it here if that ever changes.
 */
const stripJsonComments = (raw: string): string => {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const next = raw[i + 1];
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else {
      out += char;
    }
  }
  return out;
};

describe('toolchain lint/typecheck contract', () => {
  const root = join(__dirname, '..', '..');

  const readJsonc = (relative: string): any => JSON.parse(stripJsonComments(readFileSync(join(root, relative), 'utf8')));

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

/**
 * @regression   11.39.x — `readJsonc()` stripped block comments with
 *   `raw.replace(/\/\*[\s\S]*?\*\//g, '')`, which cannot tell a comment from a string literal.
 *   Every config it reads is full of globs that look like one. Measured on this repo before the
 *   fix: 2783 bytes vanished from `tsconfig.tests.json` (`src/**\/*.spec.ts` became `src*.spec.ts`) and
 *   `.oxlintrc.json` lost an entire `overrides` entry, 4 -> 3. Both still PARSED, so all four
 *   assertions in the suite above ran green against a mutilated config — for their whole life.
 *   That is the point: green was not evidence here. Reported by document-analyzer-13 via
 *   nest-server-starter-37.
 * @seen-failing Replace the `stripJsonComments` scanner body in
 *   tests/unit/toolchain-contract.spec.ts with the regex one-liner — registered as mutation
 *   `jsonc-stripper-eats-globs` in tests/regression-mutations.json.
 */
describe('toolchain contract: JSONC comment stripping', () => {
  const root = join(__dirname, '..', '..');
  const readJsonc = (relative: string): any =>
    JSON.parse(stripJsonComments(readFileSync(join(root, relative), 'utf8')));

  it('leaves a `/**/` glob intact instead of collapsing it', () => {
    // The shape the regex ate outright: the `/**/` inside the glob is a complete `/*` … `*/` pair.
    const parsed = JSON.parse(stripJsonComments('{ "include": ["src/**/*.spec.ts"] }'));
    expect(parsed.include).toEqual(['src/**/*.spec.ts']);
  });

  it('does not let a trailing `/**` open a comment that swallows the rest of the file', () => {
    // The subtler half, and the one an include-array-only fix does not cover: `src/**` has no
    // closing pair of its own, so it runs to the next `*/` ANYWHERE later in the file. This is
    // what deleted the oxlint override.
    const raw = '{ "a": ["src/**"], "b": 1, /* real comment */ "c": 2 }';
    expect(JSON.parse(stripJsonComments(raw))).toEqual({ a: ['src/**'], b: 1, c: 2 });
  });

  it('still removes real comments, both kinds', () => {
    const raw = '{\n  // line\n  "a": 1, /* block */\n  "b": 2\n}';
    expect(JSON.parse(stripJsonComments(raw))).toEqual({ a: 1, b: 2 });
  });

  it('does not treat an escaped quote as the end of a string', () => {
    const raw = '{ "a": "he said \\"/*\\" and meant it", "b": 2 }';
    expect(JSON.parse(stripJsonComments(raw))).toEqual({ a: 'he said "/*" and meant it', b: 2 });
  });

  it('keeps the real configs whole — the damage this actually caused', () => {
    // Not a synthetic shape: these are the two files the suite above reasons about, and these are
    // the exact values the regex destroyed.
    expect(readJsonc('tsconfig.tests.json').include).toContain('src/**/*.spec.ts');
    const overrides = readJsonc('.oxlintrc.json').overrides ?? [];
    expect(overrides).toHaveLength(4);
    expect(overrides.map((o: any) => o.files)).toContainEqual(['scripts/**']);
  });
});
