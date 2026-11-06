/**
 * The vendor lint gate (`pnpm run check:vendor-lint`, scripts/check-vendor-lint.mjs) lints the core the way a
 * vendor-mode project does: with nest-server-starter's oxlint configuration, in the layout the CLI gives the copied
 * core, type-aware, and with warnings as failures.
 *
 * Each case below pins one of those four properties against a small fixture tree instead of the real core, so a case
 * goes red for exactly one reason. The real core against the real starter configuration is the gate run itself
 * (`check`, the build workflow, the publish workflow).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  layoutVendorCopy,
  readStarterConfig,
  runVendorLintGate,
  vendorPath,
} from '../../scripts/check-vendor-lint.mjs';

const REPO = join(__dirname, '..', '..');
const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A tree with the given files, relative to its root. */
function tree(prefix: string, files: Record<string, string>): string {
  const root = tempDir(prefix);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/**
 * A starter checkout holding only the two files the gate reads. Every category is switched off, so a case sees only
 * the rules it names: oxlint's defaults include type-aware rules that answer "requires strictNullChecks" for every file.
 */
function starter(config: { overrides?: object[]; rules: Record<string, string> }, ignore = ''): string {
  return tree('vendor-lint-starter-', {
    '.oxlintignore': ignore,
    '.oxlintrc.json': JSON.stringify({
      categories: { correctness: 'off', suspicious: 'off' },
      plugins: ['typescript', 'unicorn'],
      ...config,
    }),
  });
}

/** Runs the gate against `root` with the starter checkout `starterPath`; never reads `CI` from the environment. */
async function gate(root: string, starterPath: string, ci = false): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await runVendorLintGate({ ci, log: (line: string) => lines.push(line), root, starterPath });
  // oxlint prints Windows paths with backslashes.
  return { code, output: lines.join('\n').replaceAll('\\', '/') };
}

afterAll(() => {
  for (const dir of created) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('check-vendor-lint — vendorPath() places files as convertCloneToVendored does', () => {
  it.each([
    ['core/common/helpers/a.ts', 'core/common/helpers/a.ts'],
    ['index.ts', 'core/index.ts'],
    ['core.module.ts', 'core/core.module.ts'],
    ['test/test.helper.ts', 'core/test/test.helper.ts'],
    ['types/express.d.ts', 'core/types/express.d.ts'],
  ])('%s -> %s', (upstream, vendored) => {
    expect(vendorPath(upstream)).toBe(vendored);
  });

  it.each(['server/server.module.ts', 'main.ts', 'config.env.ts', 'templates/email.ejs', 'corefoo.ts'])(
    'does not vendor %s',
    (upstream) => {
      expect(vendorPath(upstream)).toBeUndefined();
    },
  );
});

describe('check-vendor-lint — layoutVendorCopy() applies the flatten-fix', () => {
  it('rewrites the specifiers that still point at the upstream layout', () => {
    const root = tree('vendor-lint-root-', {
      'src/core.module.ts': "import { CoreA } from './core/common/a.js';\nexport { CoreA };\n",
      'src/core/common/a.ts': 'export class CoreA {}\n',
      'src/core/common/interfaces/core-persistence-model.interface.ts':
        "import type { CoreA } from '../../../index.js';\nexport type X = CoreA;\n",
      'src/index.ts': "export * from './core/common/a.js';\nexport * from './core.module.js';\n",
      'src/server/server.module.ts': 'export const notVendored = true;\n',
      'src/test/test.helper.ts': "import { CoreA } from '../core/common/a.js';\nexport const a = CoreA;\n",
    });
    const work = tempDir('vendor-lint-work-');

    layoutVendorCopy(root, work);

    const read = (path: string) => readFileSync(join(work, 'src', path), 'utf8');
    expect(read('core/index.ts')).toBe("export * from './common/a.js';\nexport * from './core.module.js';\n");
    expect(read('core/core.module.ts')).toContain("from './common/a.js'");
    expect(read('core/test/test.helper.ts')).toContain("from '../common/a.js'");
    expect(read('core/common/interfaces/core-persistence-model.interface.ts')).toContain("from '../../index.js'");
    expect(() => read('server/server.module.ts')).toThrow();
  });
});

describe('check-vendor-lint — the gate', () => {
  /**
   * @regression   Smoke test 2026-11-05 (DEV-4040) — the vendored core produced four warnings in the starter while
   *   this repository's lint was green, because the starter's lint only REPORTS warnings. A gate that lets warnings
   *   through passes exactly the case it exists for.
   * @seen-failing Drop `'--deny-warnings',` from the oxlint arguments in scripts/check-vendor-lint.mjs — registered
   *   as mutation `vendor-lint-allows-warnings` in tests/regression-mutations.json.
   */
  it('fails on a warning, naming the file at its vendor path', async () => {
    const root = tree('vendor-lint-root-', { 'src/core/common/a.ts': "console.log('x');\n" });

    const { code, output } = await gate(root, starter({ rules: { 'no-console': 'warn' } }));

    expect(code).toBe(1);
    expect(output).toContain('src/core/common/a.ts');
    expect(output).toContain('no-console');
  }, 60_000);

  /**
   * @regression   DEV-4040 — the starter's `lint` runs `oxlint --type-aware`, and its `no-floating-promises: error`
   *   is a type-aware rule. Without the flag oxlint skips such a rule without a word, so the gate would certify a
   *   floating promise the starter refuses.
   * @seen-failing Drop `'--type-aware',` from the oxlint arguments in scripts/check-vendor-lint.mjs — registered as
   *   mutation `vendor-lint-not-type-aware` in tests/regression-mutations.json.
   */
  it('runs the type-aware rules the starter configures', async () => {
    const root = tree('vendor-lint-root-', {
      'src/core/common/a.ts': 'async function save(): Promise<void> {}\nexport function run(): void {\n  save();\n}\n',
    });

    const { code, output } = await gate(root, starter({ rules: { 'typescript/no-floating-promises': 'error' } }));

    expect(code).toBe(1);
    expect(output).toContain('no-floating-promises');
  }, 60_000);

  /**
   * @regression   DEV-4040 — the starter scopes its exceptions for the core to `src/core/**`. Linted in this
   *   repository's layout, `src/index.ts` and `src/core.module.ts` sit outside that glob, and the gate would report
   *   warnings no vendor project has: a gate that cries wolf gets switched off.
   * @seen-failing Map `index.ts` to `index.ts` instead of `core/index.ts` in VENDOR_LAYOUT in
   *   scripts/check-vendor-lint.mjs — registered as mutation `vendor-lint-upstream-layout` in
   *   tests/regression-mutations.json.
   */
  it('lints in the vendor layout, so an exception scoped to src/core/** covers src/index.ts', async () => {
    const root = tree('vendor-lint-root-', {
      'src/core/common/a.ts': 'export const a = 1;\n',
      'src/index.ts': 'export const order = [1, 2].reverse();\n',
    });
    const config = {
      overrides: [{ files: ['src/core/**'], rules: { 'unicorn/no-array-reverse': 'off' } }],
      rules: { 'unicorn/no-array-reverse': 'warn' },
    };

    const { code, output } = await gate(root, starter(config));

    expect(output).toContain('[vendor-lint] OK');
    expect(code).toBe(0);
  }, 60_000);

  it('applies the starter ignore file', async () => {
    const root = tree('vendor-lint-root-', {
      'src/core/common/a.ts': 'export const a = 1;\n',
      'src/core/modules/migrate/templates/t.ts': "console.log('template');\n",
    });

    const { code } = await gate(root, starter({ rules: { 'no-console': 'warn' } }, '**/migrate/templates/**\n'));

    expect(code).toBe(0);
  }, 60_000);

  it('reports a run over no file as such', async () => {
    const root = tree('vendor-lint-root-', { 'src/core/data.json': '{}\n' });

    const { code, output } = await gate(root, starter({ rules: {} }));

    expect(code).toBe(1);
    expect(output).toContain('linted no file');
  }, 60_000);
});

describe('check-vendor-lint — where the configuration comes from', () => {
  const unreachable = async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };

  it('reads both files from a starter checkout', async () => {
    const result = await readStarterConfig({ starterPath: starter({ rules: {} }, 'dist\n') });

    expect(result.error).toBeUndefined();
    expect(Object.keys(result.files).sort()).toEqual(['.oxlintignore', '.oxlintrc.json']);
    expect(result.files['.oxlintignore']).toBe('dist\n');
  });

  it('names a checkout without the configuration', async () => {
    const result = await readStarterConfig({ starterPath: tempDir('vendor-lint-empty-') });

    expect(result.error).toContain('.oxlintrc.json does not exist');
  });

  it('reads the starter main on GitHub when no checkout is given', async () => {
    const requested: string[] = [];
    const fetchImpl = async (url: string) => {
      requested.push(url);
      return { ok: true, status: 200, text: async () => '{}' };
    };

    const result = await readStarterConfig({ fetchImpl });

    expect(result.error).toBeUndefined();
    expect(requested).toEqual([
      'https://raw.githubusercontent.com/lenneTech/nest-server-starter/main/.oxlintrc.json',
      'https://raw.githubusercontent.com/lenneTech/nest-server-starter/main/.oxlintignore',
    ]);
  });

  it('treats an HTTP error as unreadable, not as an empty configuration', async () => {
    const result = await readStarterConfig({
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
    });

    expect(result.error).toContain('answered 404');
  });

  it('skips with a warning locally when the configuration cannot be read', async () => {
    const lines: string[] = [];

    const code = await runVendorLintGate({
      ci: false,
      fetchImpl: unreachable,
      log: (line: string) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('SKIPPED');
    expect(lines.join('\n')).toContain('ENOTFOUND');
  });

  /**
   * @regression   DEV-4040 — locally an unreachable configuration is skipped so offline work stays possible. Under
   *   CI the same skip would be a gate that never ran and reads green.
   * @seen-failing Make the unreadable-configuration branch ignore `ci` (`if (ci) {` -> `if (false) {`) in
   *   scripts/check-vendor-lint.mjs — registered as mutation `vendor-lint-ci-skip-passes` in
   *   tests/regression-mutations.json.
   */
  it('fails under CI when the configuration cannot be read', async () => {
    const lines: string[] = [];

    const code = await runVendorLintGate({ ci: true, fetchImpl: unreachable, log: (line: string) => lines.push(line) });

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('FAIL');
  });
});

describe('check-vendor-lint — wiring', () => {
  const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));

  /**
   * @regression   DEV-4040 — a gate nothing runs catches nothing; the smoke test found the four warnings because no
   *   step of `check` linted the core with the starter's configuration.
   * @seen-failing Remove `pnpm run check:vendor-lint && ` from `check:raw` in package.json — registered as mutation
   *   `vendor-lint-not-in-check` in tests/regression-mutations.json.
   */
  it.each(['check:raw', 'check:fix', 'check:naf'])('%s runs the gate', (chain) => {
    expect(manifest.scripts[chain]).toContain('pnpm run check:vendor-lint &&');
  });

  it('the build workflow runs the gate, the publish workflow against its starter checkout', () => {
    const build = readFileSync(join(REPO, '.github', 'workflows', 'build.yml'), 'utf8');
    const publish = readFileSync(join(REPO, '.github', 'workflows', 'publish.yml'), 'utf8');

    expect(build).toContain('run: pnpm run check:vendor-lint');
    expect(publish).toContain(
      'run: node scripts/check-vendor-lint.mjs --starter="$GITHUB_WORKSPACE/consumer/nest-server-starter"',
    );
  });
});
