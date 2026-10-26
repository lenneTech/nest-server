/**
 * Module-format invariants of shipped source.
 *
 * 1. No relative dynamic `import()` in `src/`.
 *
 * `src/` is compiled with `module: nodenext` (12.0.0+), under which a dynamic `import()` in a CommonJS
 * file stays a NATIVE `import()` and follows ESM resolution. That is fine for a package specifier,
 * and wrong for a relative one, because the extension that resolves depends on who runs the file:
 *
 *  - `tsc` output needs `./x.js`;
 *  - the SWC source loader (`ts-compiler.cjs` — how vendor-mode projects run the core from source, and
 *    `bin/migrate.js` before a `dist/` exists) turns `import()` into `require()` in a CommonJS project;
 *  - vitest and SWC resolve either spelling, so the test suites stay green whichever is written.
 *
 * So there is no specifier that works everywhere. A static import does; where a cycle forces laziness,
 * move the shared binding into an import-free leaf (`core-better-auth.registry.ts` is how the tenant guard
 * recognises the IAM handlers). Type positions (`import('./x').Foo`) are erased and not affected.
 *
 * @regression   12.0.0 — `MigrationRunner.up()` / `down()` loaded their helper with
 *   `await import('./helpers/migration.helper.js')`, which threw ERR_MODULE_NOT_FOUND under ts-node in
 *   every vendor-mode project, while every suite here passed (found by the lt CLI session).
 * @seen-failing Put the dynamic import back into `MigrationRunner.runUp()` in
 *   src/core/modules/migrate/migration-runner.ts — registered as mutation
 *   `migration-runner-relative-dynamic-import` in tests/regression-mutations.json.
 *
 * 2. The core is valid as CommonJS AND as ESM.
 *
 * Since 12.0.0 a vendor-mode project may be an ESM project (`"type": "module"`, NestJS 12's default), and then the
 * vendored core is compiled and run as ESM. `pnpm run check:esm` proves that every module LOADS that way, but it
 * cannot see what only runs inside a function: a `__dirname` in a method fails on the first call, in production.
 * So the constructs that exist in only one module system are refused in the source itself — `require()`,
 * `__dirname` / `__filename`, `import x = require()` and `export =` (CommonJS only), `import.meta` (ESM only).
 * Instead: static imports, `createRequire()` for a project file, `callerDirectory()` for "next to this file".
 *
 * @regression   12.0.0 — the core located its mail templates with `__dirname`, loaded the local config with an
 *   `import()` relative to it, and imported its CommonJS dependencies with `import x = require()` — each of which fails
 *   once the core is compiled as ESM.
 * @seen-failing Put `__dirname` back where the IAM mail service locates nest-server's templates — registered as
 *   mutation `core-uses-dirname` in tests/regression-mutations.json.
 *
 * 3. The ES module graph stays loadable by `require()`.
 *
 * The package is an ES module (12.0.0+) that CommonJS projects load with `require(esm)`. Two things break that, and
 * neither shows in a suite that imports sources through vitest:
 *
 *  - a module of the graph importing from a directory a nested `package.json` keeps CommonJS (`migrate/helpers/`).
 *    That puts a CommonJS module inside the ES module graph; when it loads core modules in turn, `require()` of the
 *    barrel returns a different export list than `import()`;
 *  - top-level `await` anywhere in the graph: `require()` then throws ERR_REQUIRE_ASYNC_MODULE.
 *
 * @regression   12.0.0 (pre-release) — `migrate/index.ts` re-exported the helper from `helpers/`, which the
 *   directory's `package.json` makes CommonJS; `require()` of the barrel returned the forwarder's exports.
 * @seen-failing Point the migrate barrel at `./helpers/migration.helper.js` again — registered as mutation
 *   `barrel-imports-cjs-forwarder` in tests/regression-mutations.json.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return entry.endsWith('.ts') && !entry.endsWith('.d.ts') ? [path] : [];
  });
}

/**
 * What a vendor-mode project receives and may compile as ESM — the same set `scripts/check-esm-core.mjs` checks.
 * The migration template is a file the CLI copies into a project, not a module of the core.
 */
function dualFormatFiles(): string[] {
  return [
    ...sourceFiles(join(SRC, 'core')),
    ...sourceFiles(join(SRC, 'test')),
    join(SRC, 'index.ts'),
    join(SRC, 'core.module.ts'),
  ].filter((file) => !file.includes(`${join('migrate', 'templates')}`));
}

/** Every runtime `import('<relative>')` call in a text — `import('./x').T` type nodes are not calls. */
function relativeDynamicImports(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteralLike(specifier) && /^\.\.?\//.test(specifier.text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${fileName}:${line + 1} import('${specifier.text}')`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Constructs that exist in only one of the two module systems. `typeof require` and `require.main` are fine. */
function singleFormatConstructs(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const report = (node: ts.Node, what: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${fileName}:${line + 1} ${what}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      report(node, 'import = require()');
    } else if (ts.isExportAssignment(node) && node.isExportEquals) {
      report(node, 'export =');
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      report(node, 'import.meta');
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      report(node, 'require()');
    } else if (
      ts.isIdentifier(node) &&
      (node.text === '__dirname' || node.text === '__filename') &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    ) {
      report(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Directories below src/core/ that a nested `package.json` keeps CommonJS. */
function commonJsScopes(dir = join(SRC, 'core')): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return commonJsScopes(path);
    }
    return entry === 'package.json' && JSON.parse(readFileSync(path, 'utf8')).type === 'commonjs' ? [dir] : [];
  });
}

const insideScope = (path: string, scopes: string[]) => scopes.some((scope) => path.startsWith(scope + sep));

/** Runtime imports and re-exports of `file` that land in a CommonJS scope; `import type` is erased and not counted. */
function importsIntoCommonJsScope(file: string, text: string, scopes: string[]): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of source.statements) {
    const specifier =
      (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(statement) && !statement.isTypeOnly)
        ? statement.moduleSpecifier
        : undefined;
    if (specifier && ts.isStringLiteral(specifier) && /^\.\.?\//.test(specifier.text)) {
      if (insideScope(resolve(dirname(file), specifier.text), scopes)) {
        const { line } = source.getLineAndCharacterOfPosition(statement.getStart());
        found.push(`${relative(SRC, file)}:${line + 1} '${specifier.text}'`);
      }
    }
  }
  return found;
}

/** `await` outside any function: top-level await, which `require(esm)` refuses. */
function topLevelAwaits(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const isAwait = ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && !!node.awaitModifier);
    if (isAwait && !inFunction) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${fileName}:${line + 1}`);
    }
    ts.forEachChild(node, (child) => visit(child, inFunction || ts.isFunctionLike(node)));
  };
  visit(source, false);
  return found;
}

describe('module format invariants of shipped source', () => {
  it('has no relative dynamic import() in src/', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      relativeDynamicImports(relative(SRC, file), readFileSync(file, 'utf8')),
    );
    expect(offenders, 'use a static import, or move a cycle-forced binding into a leaf').toEqual([]);
  });

  it('finds a relative runtime import() and ignores type positions and package specifiers', () => {
    const text = [
      "export const load = () => import('./x.js');",
      "export const pkg = () => import('ioredis');",
      "export type T = import('./y').Y;",
    ].join('\n');
    expect(relativeDynamicImports('probe.ts', text)).toEqual(["probe.ts:1 import('./x.js')"]);
  });

  it('uses no construct that exists in only one module system in the core', () => {
    const offenders = dualFormatFiles().flatMap((file) =>
      singleFormatConstructs(relative(SRC, file), readFileSync(file, 'utf8')),
    );
    expect(offenders, 'see the header of this spec for the replacements').toEqual([]);
  });

  it('finds each single-format construct and leaves the guarded forms alone', () => {
    const text = [
      "import lodash = require('lodash');",
      "const a = require('./a');",
      'const b = __dirname;',
      'const c = import.meta.url;',
      "const d = typeof require !== 'undefined' && require.main === module;",
      'const e = { __dirname: 1 }.__dirname;',
      'export = a;',
    ].join('\n');
    expect(singleFormatConstructs('probe.ts', text)).toEqual([
      'probe.ts:1 import = require()',
      'probe.ts:2 require()',
      'probe.ts:3 __dirname',
      'probe.ts:4 import.meta',
      'probe.ts:7 export =',
    ]);
  });

  it('finds the CommonJS scope of the migrate helpers, so the next case has something to check', () => {
    const scopes = commonJsScopes();
    expect(scopes.map((scope) => relative(SRC, scope))).toEqual([join('core', 'modules', 'migrate', 'helpers')]);
    expect(existsSync(join(scopes[0], 'ts-compiler.js'))).toBe(true);
  });

  it('imports nothing from a CommonJS scope into the ES module graph', () => {
    const scopes = commonJsScopes();
    const offenders = dualFormatFiles()
      .filter((file) => !insideScope(file, scopes))
      .flatMap((file) => importsIntoCommonJsScope(file, readFileSync(file, 'utf8'), scopes));
    expect(offenders, 'import the module outside the CommonJS directory (e.g. ../migration.helper.js)').toEqual([]);
  });

  it('finds a runtime import into a CommonJS scope and ignores type-only ones', () => {
    const scope = join(SRC, 'probe', 'helpers');
    const text = [
      "export * from './helpers/a.js';",
      "import { b } from './helpers/b.js';",
      "import type { C } from './helpers/c.js';",
      "export type { D } from './helpers/d.js';",
      "export * from './e.js';",
    ].join('\n');
    expect(importsIntoCommonJsScope(join(SRC, 'probe', 'index.ts'), text, [scope])).toEqual([
      "probe/index.ts:1 './helpers/a.js'",
      "probe/index.ts:2 './helpers/b.js'",
    ]);
  });

  it('uses no top-level await in the core', () => {
    const offenders = dualFormatFiles().flatMap((file) => topLevelAwaits(relative(SRC, file), readFileSync(file, 'utf8')));
    expect(offenders, 'require() of the package throws ERR_REQUIRE_ASYNC_MODULE on top-level await').toEqual([]);
  });

  it('finds top-level await and leaves await inside functions alone', () => {
    const text = [
      'const a = await load();',
      'async function f() { await load(); }',
      'const g = async () => { for await (const x of y) {} };',
      'for await (const z of y) {}',
      'class K { async m() { await load(); } }',
    ].join('\n');
    expect(topLevelAwaits('probe.ts', text)).toEqual(['probe.ts:1', 'probe.ts:4']);
  });
});
