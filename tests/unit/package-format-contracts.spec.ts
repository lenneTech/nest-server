/**
 * The CommonJS islands inside this ES module package.
 *
 * Since 12.0.0 the package is `"type": "module"`. Two places stay CommonJS on purpose, because projects load them by
 * path and with `require()`: `bin/` (the `migrate` CLI) and `src/core/modules/migrate/helpers/` (the TypeScript loader
 * `ts-compiler.js`, whose function export is the `--compiler ts:` contract, and the forwarder at the old
 * `migration.helper` path that lt-CLI-generated vendor bootstraps require). A nested `package.json` with
 * `"type": "commonjs"` keeps each directory CommonJS — in the source tree, in `dist/` (copied there as a nest-cli asset)
 * and in a vendor project that copies `src/core/`.
 *
 * Nothing else notices when one of those pieces goes missing: vitest imports sources through its own module runner, the
 * build succeeds, and the failure appears in a project, on `migrate up`. So this spec loads them in place, in a child
 * process, the way a project does. `pnpm run check:manifest` repeats the same checks against the built and packed
 * package.
 *
 * @regression   12.0.0 (pre-release) — the CommonJS contracts of the ESM package were only exercised through a
 *   consumer project: a `bin/package.json` declaring the wrong format, a nest-cli asset list without `**\/*.json` (dist/
 *   then lacks `helpers/package.json`) or an emptied forwarder would each have shipped with every suite green.
 * @seen-failing Registered as mutations `bin-manifest-type-module`, `nest-cli-assets-drop-json` and
 *   `migration-helper-forwarder-emptied` in tests/regression-mutations.json.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const HELPERS = join(ROOT, 'src', 'core', 'modules', 'migrate', 'helpers');

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** The module format Node gives a `.js` file: the `type` of the nearest package.json. */
function formatOf(file: string): string {
  let dir = dirname(file);
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      return readJson(manifest).type === 'module' ? 'module' : 'commonjs';
    }
    if (dir === ROOT || dirname(dir) === dir) {
      return 'commonjs';
    }
    dir = dirname(dir);
  }
}

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === 'node_modules' ? [] : jsFiles(path);
    }
    return entry.endsWith('.js') ? [path] : [];
  });
}

/** True when a `.js` file uses `require()` or `module.exports` — comments do not count. */
function usesCommonJs(file: string): boolean {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
      (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'module' &&
        node.name.text === 'exports')
    ) {
      found = true;
    }
    if (!found) {
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  return found;
}

function runNode(args: string[]) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
}

describe('CommonJS contracts inside the ES module package', () => {
  it('is an ES module package that ships bin/, dist/ and src/', () => {
    const pkg = readJson(join(ROOT, 'package.json'));
    expect(pkg.type).toBe('module');
    expect(pkg.files).toEqual(expect.arrayContaining(['bin/**/*', 'dist/**/*', 'src/**/*']));
  });

  it('places every CommonJS .js file in a CommonJS scope', () => {
    const misplaced = [...jsFiles(join(ROOT, 'bin')), ...jsFiles(join(ROOT, 'src'))]
      .filter(usesCommonJs)
      .filter((file) => formatOf(file) !== 'commonjs')
      .map((file) => relative(ROOT, file));
    expect(misplaced, 'add a package.json with "type": "commonjs" to the directory, or rename to .cjs').toEqual([]);
  });

  it('copies the nested manifests into dist/', () => {
    // Without them dist/core/modules/migrate/helpers/ holds CommonJS files in an ES module scope.
    const assets: string[] = readJson(join(ROOT, 'nest-cli.json')).compilerOptions.assets;
    expect(assets.some((asset) => asset === '**/*.json' || asset.endsWith('package.json'))).toBe(true);
  });

  it('runs the migrate CLI from bin/', () => {
    const result = runNode(['bin/migrate.js', '--help']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('exports the loader function from the established path', () => {
    const result = runNode(['-e', `console.log(typeof require(${JSON.stringify(join(HELPERS, 'ts-compiler.js'))}))`]);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('function');
  });

  it('forwards the whole migration helper API from the old path', () => {
    // How a vendor project's migrations-utils/migrate.js loads it: through the loader, with require().
    const forwarder = JSON.stringify(join(HELPERS, 'migration.helper.ts'));
    const helper = JSON.stringify(join(HELPERS, '..', 'migration.helper.ts'));
    const keys = (path: string) =>
      `Object.keys(require(${path})).filter((k) => k !== '__esModule' && k !== 'module.exports').sort().join()`;
    const result = runNode([
      '-r',
      join(HELPERS, 'ts-compiler.js'),
      '-e',
      `console.log(JSON.stringify([${keys(forwarder)}, ${keys(helper)}]))`,
    ]);
    expect(result.stderr).toBe('');
    const [forwarded, original] = JSON.parse(result.stdout);
    expect(original).toContain('createMigrationStore');
    expect(forwarded).toBe(original);
  });
});
