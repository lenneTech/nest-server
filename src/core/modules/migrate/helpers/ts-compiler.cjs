/**
 * TypeScript loader for running sources without a build — the migrate CLI, the dev server and scripts.
 *
 * Registers a CommonJS `require` hook that compiles `.ts` / `.cts` files with SWC (`@swc/core`) on load, and — for
 * ESM projects (`"type": "module"`, what `nest new` creates since NestJS 12) — the matching ESM hooks
 * (`ts-compiler-hooks.mjs`, through `module.register()`), so `import` reaches TypeScript sources the same way.
 * It is the framework's replacement for ts-node (12.0.0): ts-node is unmaintained, needed TypeScript-6
 * workarounds (TS5011 / TS5107 / TS5110 from inherited compiler options), type-checked what it
 * loaded on every start, and — like `@swc-node/register`, whose peer range ends below TypeScript 7 —
 * depends on TypeScript's JavaScript API. This loader does not touch TypeScript at all: it only
 * strips types and lowers decorators, with the same compiler vitest (unplugin-swc) and
 * `nest build -b swc` already use. Type errors are reported by `tsc` (build, `check`, the IDE), not here.
 *
 * Usage:
 *
 *   migrate up --compiler="ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js"
 *   node -r ./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js src/main.ts
 *
 * Requiring the file registers the hook; the exported function does the same and is idempotent, which
 * is the contract `--compiler ts:<file>` relies on (the CLI requires the file and calls its export).
 *
 * `@swc/core` is resolved from the working directory first (the project that runs the sources), then
 * from this file — in an isolated pnpm layout only the project's own `node_modules` holds it.
 */
'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isMainThread } = require('node:worker_threads');

// The loader table Node's CommonJS `require` dispatches on by extension — what every require hook patches.
// oxlint-disable-next-line no-underscore-dangle -- Node's own name for it
const extensionHandlers = Module._extensions;

// A CONTRACT, not an implementation detail: the lt CLI's vendor bootstrap (migrations-utils/ts-compiler.js)
// checks the registered `.ts` handler for this exact key to tell this loader from an older core's ts-node
// export. Renaming it makes every vendor project fall back to ts-node — pinned by tests/unit/ts-compiler.spec.ts.
const MARKER = Symbol.for('lenne.tech/nest-server/ts-compiler');

/**
 * Mirrors the `tsc` build (`tsconfig.json` → `target: es2022`), so a source run behaves like `dist/`:
 *
 * - legacy decorators + decorator metadata: NestJS DI, `@UnifiedField`, `@Prop` and `@Field` read the
 *   emitted `design:*` metadata;
 * - `useDefineForClassFields: true` is what `tsc` does for `target: es2022`. `@nestjs/cli`'s own SWC
 *   defaults use `false`, under which a declared field without an initializer is not an own property —
 *   a difference from the production build, not a detail;
 * - `keepClassNames`: class names are DI tokens, logger contexts and GraphQL type names.
 *
 * `.swcrc` is ignored on purpose: the result must not depend on a file a project keeps for another tool.
 * `tests/unit/ts-compiler.spec.ts` pins these against the repository's tsconfig.
 */
const SWC_OPTIONS = {
  configFile: false,
  jsc: {
    keepClassNames: true,
    parser: { decorators: true, dynamicImport: true, syntax: 'typescript' },
    target: 'es2022',
    transform: { decoratorMetadata: true, legacyDecorator: true, useDefineForClassFields: true },
  },
  module: { type: 'commonjs' },
  sourceMaps: 'inline',
  swcrc: false,
};

/** Extensions the hook compiles. `.mts` is ESM and never reaches a `require` hook. */
const EXTENSIONS = ['.ts', '.cts'];

/**
 * The TypeScript source a `.js` / `.cjs` specifier names, the way `tsc` and vitest read it: ESM requires the
 * extension of the EMITTED file (`./x.js`), so a relative specifier written for both module systems points at
 * a file that only exists after a build. A source run maps it back to `x.ts` / `x.cts`.
 */
const SOURCE_EXTENSIONS = { '.cjs': ['.cts'], '.js': ['.ts', '.cts'] };

/** Marks the patched resolver, so registering twice does not wrap it twice. */
const RESOLVE_MARKER = Symbol.for('lenne.tech/nest-server/ts-compiler/resolve');

/**
 * Let `require('./x.js')` from a TypeScript file find `x.ts` when no `x.js` exists. Only path-like requests
 * from a compiled TypeScript parent are retried, and only after Node's own resolution failed — a real `.js`
 * file always wins, and package specifiers are never touched.
 */
function patchResolver() {
  // oxlint-disable-next-line no-underscore-dangle -- Node's own resolver, what every TypeScript require hook wraps
  const original = Module._resolveFilename;
  if (original[RESOLVE_MARKER]) {
    return;
  }
  function resolveTypeScriptSource(request, parent, ...rest) {
    try {
      return original.call(this, request, parent, ...rest);
    } catch (error) {
      const extension = request.match(/\.c?js$/)?.[0];
      const fromTypeScript = /\.c?ts$/.test(parent?.filename ?? '');
      if (error?.code !== 'MODULE_NOT_FOUND' || !extension || !fromTypeScript || !/^\.{0,2}\//.test(request)) {
        throw error;
      }
      const stem = request.slice(0, -extension.length);
      for (const sourceExtension of SOURCE_EXTENSIONS[extension]) {
        try {
          return original.call(this, stem + sourceExtension, parent, ...rest);
        } catch {
          // try the next one; the original error is the one worth reporting
        }
      }
      throw error;
    }
  }
  resolveTypeScriptSource[RESOLVE_MARKER] = true;
  // oxlint-disable-next-line no-underscore-dangle -- see above
  Module._resolveFilename = resolveTypeScriptSource;
}

/**
 * Load `@swc/core`, or fail with the one instruction that fixes it.
 *
 * @param {string[]} [paths] - Where to resolve it from; defaults to the working directory, then this file.
 */
function loadSwc(paths = [process.cwd(), __dirname]) {
  let resolved;
  try {
    resolved = require.resolve('@swc/core', { paths });
  } catch {
    const error = new Error(
      'Running TypeScript sources needs @swc/core, which this project does not have. ' +
        'Add it as a devDependency: pnpm add -D @swc/core',
    );
    error.code = 'LT_SWC_CORE_MISSING';
    throw error;
  }
  return require(resolved);
}

/**
 * Register the hook. Safe to call more than once.
 */
function register() {
  if (extensionHandlers['.ts']?.[MARKER]) {
    return;
  }
  const swc = loadSwc();
  // Stack traces point at the TypeScript lines (the code carries inline source maps).
  process.setSourceMapsEnabled(true);

  function compileTypeScript(module, filename) {
    const { code } = swc.transformSync(fs.readFileSync(filename, 'utf8'), { ...SWC_OPTIONS, filename });
    // oxlint-disable-next-line no-underscore-dangle -- the CommonJS module API every require hook calls
    module._compile(code, filename);
  }
  compileTypeScript[MARKER] = true;
  for (const extension of EXTENSIONS) {
    extensionHandlers[extension] = compileTypeScript;
  }
  patchResolver();
  registerEsmHooks();
}

/** Marks the process once the ESM hooks are registered. */
const ESM_MARKER = Symbol.for('lenne.tech/nest-server/ts-compiler/esm');

/**
 * Register the ESM hooks (`ts-compiler-hooks.mjs`) for `import`ed TypeScript: an ESM project's entry and everything it
 * imports. Without them Node would hand a `.ts` entry to its own type stripping, which cannot lower decorators or emit
 * their metadata — NestJS needs both. Only on the main thread: the hooks run on a thread of their own, which loads this
 * file for its SWC options and must not register itself again.
 */
function registerEsmHooks() {
  if (!isMainThread || typeof Module.register !== 'function' || globalThis[ESM_MARKER]) {
    return;
  }
  globalThis[ESM_MARKER] = true;
  Module.register(pathToFileURL(path.join(__dirname, 'ts-compiler-hooks.mjs')).href);
}

register();

module.exports = register;
module.exports.loadSwc = loadSwc;
module.exports.SWC_OPTIONS = SWC_OPTIONS;
module.exports.SOURCE_EXTENSIONS = SOURCE_EXTENSIONS;
