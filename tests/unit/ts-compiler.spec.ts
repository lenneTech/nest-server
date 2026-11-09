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

/**
 * The Node lines whose `module.registerHooks()` hands a CommonJS module imported from ESM back to the CommonJS loader
 * (a `load` result without `source`). Measured on 22.15.0, 22.22.0, 23.5.0, 23.11.1, 24.0.0, 24.6.0, 24.10.0, 24.11.0
 * and 25.0.0 (refused: "Expected a string … for the "source" from the "load" hook") and on 24.12.0, 24.13.0, 26.0.0
 * and 26.13.0 (accepted). 25.x is end-of-life and keeps the older path. Stated here on its own, not read from the
 * loader: the expectation must not move with the code it checks.
 */
function handsBackCommonJs(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major >= 26 || (major === 24 && minor >= 12);
}

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
    const probeLine =
      readFileSync(FIXTURE, 'utf8')
        .split('\n')
        .findIndex((line) => line.includes('// stack-probe')) + 1;
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
   * @seen-failing Drop `keepImportAssertions` from src/core/modules/migrate/helpers/ts-compiler.cjs — registered
   *   as mutation `esm-hooks-drop-import-attributes` in tests/regression-mutations.json.
   *
   * @regression   12.8.3 (DEV-4134, pre-release) — under `module.registerHooks()` a CommonJS-scoped TypeScript file
   *   imported from ESM must go back to the CommonJS loader without a source. Compiled inside the load hook it runs
   *   with the reduced `require` Node builds for such a source (no `require.cache`) on 24, and crashes Node 22.
   * @seen-failing Return the compiled CommonJS source from `loadTypeScript()` in
   *   src/core/modules/migrate/helpers/ts-compiler.cjs — registered as mutation `ts-hooks-commonjs-compiled-in-hook`
   *   in tests/regression-mutations.json.
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
    writeFileSync(
      join(dir, 'node_modules', 'esm-tla', 'index.js'),
      'export const value = await Promise.resolve(42);\n',
    );
    writeFileSync(
      join(dir, 'src', 'dep.ts'),
      'export class Dependency {}\nexport function Injectable(): ClassDecorator { return () => undefined; }\n',
    );
    writeFileSync(join(dir, 'src', 'data.json'), '{"name":"from-json"}\n');
    // CommonJS-scoped TypeScript imported from ESM: handed back to the CommonJS loader, where the `require` hook
    // compiles it — `require.cache` exists only there, a module compiled inside the load hook runs without it.
    writeFileSync(
      join(dir, 'src', 'legacy.cts'),
      [
        "import { Dependency } from './dep.js';",
        "export const legacy: string = ['from legacy.cts', typeof Dependency, typeof require.cache].join(':');",
      ].join('\n'),
    );
    writeFileSync(join(dir, 'src', 'required.ts'), "export const required: string = 'from required.ts';\n");
    writeFileSync(
      join(dir, 'src', 'main.ts'),
      [
        "import 'reflect-metadata';",
        "import _ from 'lodash';",
        "import { value } from 'esm-tla';",
        "import { Dependency, Injectable } from './dep.js';",
        "import data from './data.json' with { type: 'json' };",
        "import legacyModule from './legacy.cjs';",
        "import { createRequire } from 'node:module';",
        '@Injectable()',
        'class Service { constructor(readonly dependency: Dependency, readonly name: string) {} }',
        'console.log(JSON.stringify({',
        '  json: data.name,',
        '  legacy: (legacyModule as { legacy: string }).legacy,',
        "  required: createRequire(import.meta.url)('./required.ts').required,",
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
      legacy: 'from legacy.cts:function:object',
      lodash: 'function',
      metaUrl: 'string',
      paramTypes: ['Dependency', 'String'],
      required: 'from required.ts',
      topLevelAwait: 42,
    });
  });

  /**
   * @regression   12.8.3 (DEV-4134) — the loader registered its ESM hooks with `module.register()`, which Node 26
   *   deprecates at runtime: every start and every migration of an ESM or CommonJS project printed DEP0205. Where
   *   Node's synchronous hooks can hand a CommonJS module imported from ESM back to the CommonJS loader (24.12+, 26+),
   *   the loader now uses `module.registerHooks()`; older lines keep `module.register()`, which warns nowhere there.
   * @seen-failing Make `registerHooksHandsBackCommonJs()` in src/core/modules/migrate/helpers/ts-compiler.cjs answer
   *   `false` — registered as mutation `ts-loader-uses-module-register` in tests/regression-mutations.json.
   */
  it('registers its import hooks with module.registerHooks() where Node supports it, without a deprecation warning', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(dir, 'src', 'dep.ts'), "export const dep: string = 'from dep.ts';\n");
    writeFileSync(join(dir, 'src', 'legacy.cts'), "export const legacy: string = 'from legacy.cts';\n");
    writeFileSync(
      join(dir, 'src', 'main.ts'),
      [
        "import { dep } from './dep.js';",
        "import legacyModule from './legacy.cjs';",
        'const calls = (globalThis as any).__hookApiCalls;',
        'console.log(JSON.stringify({ calls, dep, legacy: (legacyModule as { legacy: string }).legacy }));',
      ].join('\n'),
    );
    // Counts which of the two hook APIs the loader calls, and still lets each of them work.
    writeFileSync(
      join(dir, 'count-hook-apis.cjs'),
      [
        "const Module = require('node:module');",
        'const calls = (globalThis.__hookApiCalls = { register: 0, registerHooks: 0 });',
        'for (const name of Object.keys(calls)) {',
        '  const original = Module[name];',
        '  if (typeof original === "function") {',
        '    Module[name] = function (...args) { calls[name] += 1; return original.apply(this, args); };',
        '  }',
        '}',
      ].join('\n'),
    );
    // A deprecation is an exception here, so a DEP0205 cannot hide in a stderr nobody reads.
    const { code, stderr, stdout } = node(
      ['--throw-deprecation', '-r', join(dir, 'count-hook-apis.cjs'), '-r', LOADER, join(dir, 'src', 'main.ts')],
      dir,
    );
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      calls: handsBackCommonJs(process.versions.node)
        ? { register: 0, registerHooks: 1 }
        : { register: 1, registerHooks: 0 },
      dep: 'from dep.ts',
      legacy: 'from legacy.cts',
    });
  });

  it('uses module.registerHooks() exactly on the Node lines that hand CommonJS back to the CommonJS loader', () => {
    const { stdout } = node([
      '-e',
      [
        `const { registerHooksHandsBackCommonJs: hands } = require(${JSON.stringify(LOADER)});`,
        "const versions = ['22.15.0', '22.22.0', '23.11.1', '24.0.0', '24.11.1', '24.12.0', '24.13.0', '25.0.0', '25.9.0', '26.0.0', '26.13.0', '27.0.0'];",
        'process.stdout.write(JSON.stringify(Object.fromEntries(versions.map((v) => [v, hands(v)]))));',
      ].join('\n'),
    ]);
    // The measurements behind each row: see handsBackCommonJs() above.
    expect(JSON.parse(stdout)).toEqual({
      '22.15.0': false,
      '22.22.0': false,
      '23.11.1': false,
      '24.0.0': false,
      '24.11.1': false,
      '24.12.0': true,
      '24.13.0': true,
      '25.0.0': false,
      '25.9.0': false,
      '26.0.0': true,
      '26.13.0': true,
      '27.0.0': true,
    });
  });

  it('compiles the way the tsc build does (tsconfig.json)', () => {
    const { config } = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
    const compilerOptions = config.compilerOptions;
    const { stdout } = node([
      '-e',
      `process.stdout.write(JSON.stringify(require(${JSON.stringify(LOADER)}).SWC_OPTIONS))`,
    ]);
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
