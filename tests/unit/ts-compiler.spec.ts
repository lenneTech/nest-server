import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The framework's TypeScript loader (`src/core/modules/migrate/helpers/ts-compiler.js`), which replaced
 * ts-node in 12.0.0. It runs the dev server, the migrate CLI from source, `docs:ci`, and — through
 * `--compiler ts:…` — every consumer's TypeScript migrations and `config.env.ts`.
 *
 * Everything runs in a child process: the loader patches `require.extensions`, which must not happen
 * inside a vitest worker, and a child is also the only place the real `node -r <loader>` path exists.
 * Costs a few short `node` children, needs no MongoDB, and stays in the unit runner.
 */

const ROOT = process.cwd();
const LOADER = join(ROOT, 'src/core/modules/migrate/helpers/ts-compiler.js');
// CommonJS-scoped (fixtures/cjs/package.json): this case covers the `require` hook, i.e. a CommonJS project.
const FIXTURE = join(ROOT, 'tests/unit/fixtures/cjs/ts-compiler-child.ts');

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ts-compiler-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function node(args: string[], cwd = ROOT) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
    timeout: 60_000,
  });
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe('TypeScript loader (ts-compiler.js)', () => {
  it('compiles the TypeScript a NestJS source run depends on', () => {
    const { code, stderr, stdout } = node(['-r', LOADER, FIXTURE]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const result = JSON.parse(stdout);

    // DI and every field decorator read the emitted metadata; without it Nest cannot construct anything.
    expect(result.paramTypes).toEqual(['Dependency', 'String']);
    expect(result.propertyType).toBe('String');
    expect(result.className).toBe('Service');
    expect(result.enumValue).toBe('b');
    expect(result.importEquals).toBe('function');
    // tsc with `target: es2022` makes a declared field an own property; @nestjs/cli's SWC defaults do not.
    expect(result.declaredIsOwnProperty).toBe(true);

    // Stack traces name the TypeScript line, not a line of the compiled output.
    const probeLine = readFileSync(FIXTURE, 'utf8').split('\n').findIndex((line) => line.includes('// stack-probe')) + 1;
    expect(result.stack).toContain(`ts-compiler-child.ts:${probeLine}:`);
  });

  /**
   * ESM needs the extension of the EMITTED file in a relative specifier (`./x.js`), so the core writes its
   * imports that way to be valid in both module systems (12.0.0). A source run has no `x.js` — only `x.ts`.
   */
  it('resolves a .js specifier to its TypeScript source, and a real .js file still wins', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'dep.ts'), "export const value: string = 'from dep.ts';\n");
    writeFileSync(join(dir, 'real.ts'), "export const value: string = 'from real.ts';\n");
    writeFileSync(join(dir, 'real.js'), "exports.value = 'from real.js';\n");
    writeFileSync(
      join(dir, 'main.ts'),
      [
        "import { value as dep } from './dep.js';",
        "import { value as real } from './real.js';",
        'let missing = "";',
        "try { require('./missing.js'); } catch (error) { missing = (error as NodeJS.ErrnoException).code ?? ''; }",
        'console.log(JSON.stringify({ dep, missing, real }));',
      ].join('\n'),
    );
    const { code, stderr, stdout } = node(['-r', LOADER, join(dir, 'main.ts')], dir);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ dep: 'from dep.ts', missing: 'MODULE_NOT_FOUND', real: 'from real.js' });
  });

  /**
   * An ESM project (`"type": "module"`, the NestJS 12 default) run from source: Node would hand a `.ts` entry to its
   * own type stripping, which cannot lower decorators. The loader's ESM hooks compile it with SWC instead — and an ESM
   * project is the one place an ESM-only package with top-level await can be imported at all.
   */
  /**
   * @regression   12.0.0 (pre-release) — the ESM hooks compiled with SWC's defaults, which drop import attributes: an ESM
   *   project's `import pkg from '../package.json' with { type: 'json' }` (what the starter's main.ts does) reached Node
   *   without its attribute and the dev start died with ERR_IMPORT_ATTRIBUTE_MISSING, while `tsc` built it fine.
   * @seen-failing Drop `keepImportAssertions` from src/core/modules/migrate/helpers/ts-compiler-hooks.mjs — registered
   *   as mutation `esm-hooks-drop-import-attributes` in tests/regression-mutations.json.
   */
  it('runs an ESM project from source: decorators, .js specifiers, JSON imports, CommonJS and top-level-await ESM packages', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules', 'esm-tla'), { recursive: true });
    for (const pkg of ['reflect-metadata', 'lodash']) {
      symlinkSync(join(ROOT, 'node_modules', pkg), join(dir, 'node_modules', pkg), 'junction');
    }
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(dir, 'node_modules', 'esm-tla', 'package.json'),
      '{"name":"esm-tla","type":"module","exports":{"import":"./index.js"}}\n',
    );
    writeFileSync(join(dir, 'node_modules', 'esm-tla', 'index.js'), 'export const value = await Promise.resolve(42);\n');
    writeFileSync(
      join(dir, 'src', 'dep.ts'),
      'export class Dependency {}\nexport function Injectable(): ClassDecorator { return () => undefined; }\n',
    );
    writeFileSync(join(dir, 'src', 'data.json'), '{"name":"from-json"}\n');
    writeFileSync(
      join(dir, 'src', 'main.ts'),
      [
        "import 'reflect-metadata';",
        "import _ from 'lodash';",
        "import { value } from 'esm-tla';",
        "import { Dependency, Injectable } from './dep.js';",
        "import data from './data.json' with { type: 'json' };",
        '@Injectable()',
        'class Service { constructor(readonly dependency: Dependency, readonly name: string) {} }',
        'console.log(JSON.stringify({',
        '  json: data.name,',
        '  lodash: typeof _.merge,',
        '  metaUrl: typeof import.meta.url,',
        "  paramTypes: (Reflect.getMetadata('design:paramtypes', Service) ?? []).map((t: any) => t.name),",
        '  topLevelAwait: value,',
        '}));',
      ].join('\n'),
    );
    const { code, stderr, stdout } = node(['-r', LOADER, join(dir, 'src', 'main.ts')], dir);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      json: 'from-json',
      lodash: 'function',
      metaUrl: 'string',
      paramTypes: ['Dependency', 'String'],
      topLevelAwait: 42,
    });
  });

  it('compiles the way the tsc build does (tsconfig.json)', () => {
    const { config } = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
    const compilerOptions = config.compilerOptions;
    const { stdout } = node(['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(LOADER)}).SWC_OPTIONS))`]);
    const options = JSON.parse(stdout);

    // A change on either side must be made on both, or source runs and dist/ behave differently.
    expect(options.jsc.target).toBe(compilerOptions.target.toLowerCase());
    expect(compilerOptions.experimentalDecorators).toBe(true);
    expect(options.jsc.transform.legacyDecorator).toBe(true);
    expect(compilerOptions.emitDecoratorMetadata).toBe(true);
    expect(options.jsc.transform.decoratorMetadata).toBe(true);
    // tsc defaults useDefineForClassFields to true for ES2022 and later; the loader states it explicitly.
    expect(compilerOptions.useDefineForClassFields ?? true).toBe(options.jsc.transform.useDefineForClassFields);
    expect(options.module.type).toBe('commonjs');
    expect(options.swcrc).toBe(false);
  });

  it('is idempotent and keeps the `--compiler ts:<file>` contract (a function export)', () => {
    const script = [
      `const register = require(${JSON.stringify(LOADER)});`,
      "const handler = require.extensions['.ts'];",
      'register();',
      'register();',
      "const marker = handler[Symbol.for('lenne.tech/nest-server/ts-compiler')];",
      "process.stdout.write(JSON.stringify({ export: typeof register, same: require.extensions['.ts'] === handler, cts: require.extensions['.cts'] === handler, marker }));",
    ].join('\n');
    const { code, stdout } = node(['-e', script]);
    expect(code).toBe(0);
    // `marker`: the lt CLI's vendor bootstrap recognises this loader by that exact Symbol.for() key.
    expect(JSON.parse(stdout)).toEqual({ cts: true, export: 'function', marker: true, same: true });
  });

  it('does not depend on the TypeScript compiler API', () => {
    // The reason for an own loader: ts-node and @swc-node/register both read tsconfig through
    // TypeScript's JavaScript API, which TypeScript 7 no longer ships in that form.
    expect(readFileSync(LOADER, 'utf8')).not.toMatch(/require\(\s*['"]typescript['"]\s*\)/);
  });

  it('names the fix when @swc/core is not installed', () => {
    const dir = tempDir();
    // The entry and the implementation it forwards to, away from any node_modules that holds @swc/core.
    for (const file of ['ts-compiler.js', 'ts-compiler.cjs', 'ts-compiler-hooks.mjs']) {
      copyFileSync(join(dirname(LOADER), file), join(dir, file));
    }
    const { code, stderr } = node(['-e', "require('./ts-compiler.js')"], dir);
    expect(code).not.toBe(0);
    expect(stderr).toContain('pnpm add -D @swc/core');
  });

  it('lets bin/migrate.js run the CLI from its TypeScript source (vendor repo, no build)', () => {
    // A project layout without dist/: bin/migrate.js next to a src/ that is this repository's source.
    const project = tempDir();
    mkdirSync(join(project, 'bin'));
    copyFileSync(join(ROOT, 'bin/migrate.js'), join(project, 'bin/migrate.js'));
    symlinkSync(join(ROOT, 'src'), join(project, 'src'), 'junction');

    const { code, stdout } = node([join(project, 'bin/migrate.js'), '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
  });
});
