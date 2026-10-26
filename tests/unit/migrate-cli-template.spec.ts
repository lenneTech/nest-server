/**
 * `migrate create` in a vendor-mode project must not write a migration that imports a package the
 * project does not have.
 *
 * @regression   12.0.0 (pre-existing) — the shipped template imports `getDb` / `uploadFileToGridFS`
 *   from `@lenne.tech/nest-server`; in a vendor-mode project (core in `src/core/`, no package) every
 *   migration created from it failed with TS2307 under ts-node and with MODULE_NOT_FOUND from `dist/`.
 *   The CLI's vendor conversion only rewrites EXISTING migrations, and the template is excluded from
 *   the tsconfig, so it never surfaced (found by the lt CLI session).
 * @seen-failing Drop the `rewriteFrameworkSpecifier()` call from `createMigration()` in
 *   src/core/modules/migrate/cli/migrate-cli.ts — registered as mutation
 *   `migrate-create-vendor-specifier-unwired` in tests/regression-mutations.json.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createMigration,
  rewriteFrameworkSpecifier,
  vendoredFrameworkSpecifier,
} from '../../src/core/modules/migrate/cli/migrate-cli';

const TEMPLATE = join(__dirname, '..', '..', 'src', 'core', 'modules', 'migrate', 'templates', 'migration-project.template.ts');

const dirs: string[] = [];
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-cli-template-'));
  dirs.push(dir);
  return dir;
}

/** A vendor-mode api: the core under src/core with the entry point the flatten-fix leaves there. */
function vendorProject(): { coreRoot: string; root: string } {
  const root = tempProject();
  const coreRoot = join(root, 'src', 'core');
  mkdirSync(coreRoot, { recursive: true });
  writeFileSync(join(coreRoot, 'index.ts'), 'export {};\n');
  return { coreRoot, root };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('migrate create — framework import in vendor-mode projects', () => {
  it('points the template at the vendored core when the package is not installed', () => {
    const { coreRoot, root } = vendorProject();
    expect(vendoredFrameworkSpecifier('migrations', root, coreRoot)).toBe('../src/core');
    expect(vendoredFrameworkSpecifier(join(root, 'db', 'migrations'), root, coreRoot)).toBe('../../src/core');
  });

  it('keeps the package name when the package resolves (npm mode)', () => {
    const { coreRoot, root } = vendorProject();
    const pkg = join(root, 'node_modules', '@lenne.tech', 'nest-server');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ main: 'index.js', name: '@lenne.tech/nest-server' }));
    writeFileSync(join(pkg, 'index.js'), 'module.exports = {};\n');
    expect(vendoredFrameworkSpecifier('migrations', root, coreRoot)).toBeUndefined();
  });

  it('keeps the package name when the core has no entry point of its own (this framework repo)', () => {
    const root = tempProject();
    const coreRoot = join(root, 'src', 'core');
    mkdirSync(coreRoot, { recursive: true });
    expect(vendoredFrameworkSpecifier('migrations', root, coreRoot)).toBeUndefined();
  });

  it('rewrites only the exact package specifier', () => {
    const source = [
      "import { getDb } from '@lenne.tech/nest-server';",
      'const x = require("@lenne.tech/nest-server");',
      "import { y } from '@lenne.tech/nest-server/dist/whatever';",
    ].join('\n');
    expect(rewriteFrameworkSpecifier(source, '../src/core')).toBe(
      [
        "import { getDb } from '../src/core';",
        'const x = require("../src/core");',
        "import { y } from '@lenne.tech/nest-server/dist/whatever';",
      ].join('\n'),
    );
  });

  it('writes a migration from the shipped template that imports the vendored core', async () => {
    const { coreRoot, root } = vendorProject();
    const migrationsDir = join(root, 'migrations');
    // The package is not resolvable from this repository either, so only the injected core decides.
    await createMigration('add-thing', { migrationsDir, templateFile: TEMPLATE }, coreRoot);

    const [file] = readdirSync(migrationsDir);
    const written = readFileSync(join(migrationsDir, file), 'utf-8');
    expect(readFileSync(TEMPLATE, 'utf-8')).toContain("from '@lenne.tech/nest-server'");
    expect(written).toContain("from '../src/core'");
    expect(written).not.toContain("'@lenne.tech/nest-server'");
  });
});

/**
 * @regression   12.0.0 (pre-release) — the template looked for config.env only under `<cwd>/src`. A migration run
 *   from `dist/migrations` in an image without `src/` (and without the env var) therefore threw "MongoDB URI not
 *   available" although the compiled `dist/src/config.env.js` sat right next to it.
 * @seen-failing Reduce `configCandidates` to `<cwd>/src/config.env` — registered as mutation
 *   `migration-template-config-src-only` in tests/regression-mutations.json.
 */
describe('migration template — MongoDB URI lookup in a compiled project', () => {
  const CONFIGURED = 'mongodb://configured.example/app';

  /**
   * A project as the build leaves it: the migration compiled to `dist/migrations`, the config compiled to
   * `dist/src/config.env.js`, no `src/` at all. The framework package is a stub whose `getDb()` prints the URI.
   */
  function compiledProject(format: 'commonjs' | 'module', withConfig = true): string {
    const root = tempProject();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'compiled-api', type: format }));

    const pkg = join(root, 'node_modules', '@lenne.tech', 'nest-server');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ main: 'index.js', name: '@lenne.tech/nest-server' }));
    writeFileSync(
      join(pkg, 'index.js'),
      "exports.getDb = async (uri) => { console.log('URI=' + uri); return {}; };\nexports.uploadFileToGridFS = async () => undefined;\n",
    );

    if (withConfig) {
      mkdirSync(join(root, 'dist', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'dist', 'src', 'config.env.js'),
        format === 'module'
          ? `export default { mongoose: { uri: '${CONFIGURED}' } };\n`
          : `module.exports = { mongoose: { uri: '${CONFIGURED}' } };\n`,
      );
    }

    const { outputText } = ts.transpileModule(readFileSync(TEMPLATE, 'utf-8'), {
      compilerOptions: {
        module: format === 'module' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    });
    mkdirSync(join(root, 'dist', 'migrations'), { recursive: true });
    writeFileSync(join(root, 'dist', 'migrations', '1700000000000-test.js'), outputText);
    return root;
  }

  /** Loads the compiled migration from the project root, as `migrate up` does, and runs `up()`. */
  function runUp(root: string, env: Record<string, string> = {}) {
    const migration = pathToFileURL(join(root, 'dist', 'migrations', '1700000000000-test.js')).href;
    const inherited = { ...process.env };
    delete inherited.NSC__MONGOOSE__URI;
    return spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const m = await import(${JSON.stringify(migration)}); await m.up();`],
      { cwd: root, encoding: 'utf-8', env: { ...inherited, ...env } },
    );
  }

  it.each(['commonjs', 'module'] as const)('reads dist/src/config.env without the env var (%s project)', (format) => {
    const result = runUp(compiledProject(format));
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`URI=${CONFIGURED}`);
  });

  it('falls back to NSC__MONGOOSE__URI when no config.env is loadable', () => {
    const result = runUp(compiledProject('commonjs', false), { NSC__MONGOOSE__URI: 'mongodb://from-env.example/app' });
    expect(result.stdout).toContain('URI=mongodb://from-env.example/app');
  });

  it('refuses to run without either source', () => {
    const result = runUp(compiledProject('module', false));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MongoDB URI not available');
  });
});
