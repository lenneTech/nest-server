/**
 * TypeScript loader for running sources without a build — the migrate CLI, the dev server and scripts.
 *
 * Registers a CommonJS `require` hook that compiles `.ts` / `.cts` files with SWC (`@swc/core`) on load, and — for
 * ESM projects (`"type": "module"`, what `nest new` creates since NestJS 12) — the matching module hooks, so `import`
 * reaches TypeScript sources the same way: in-thread through `module.registerHooks()` where Node supports what the
 * loader needs (24.12+, 26+), otherwise through `module.register()` and `ts-compiler-hooks.mjs` (see
 * `registerHooksHandsBackCommonJs()`).
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
const { fileURLToPath, pathToFileURL } = require('node:url');
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

/** `@swc/core`, loaded once per thread by `register()` or by the first ESM file compiled. */
let swc;

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
  swc ??= loadSwc();
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
  // Node 24.22+ and 26 pick the handler of a module whose load hook named its format BY THAT FORMAT, not by the file's
  // extension: `commonjs` means `.js`. That happens when the ESM loader hands a CommonJS-scoped `.ts` / `.cts` file
  // back (`loadTypeScript()`), which it does for a CommonJS entry as soon as a second, asynchronous loader runs next to
  // this one (an instrumentation preload through `--import`), and for an ESM project's `.cts` import. Without this,
  // the file would be compiled as plain JavaScript. Any other file keeps Node's own handler.
  const javaScriptHandler = extensionHandlers['.js'];
  function compileTypeScriptReachingJavaScriptHandler(module, filename) {
    return /\.c?ts$/.test(filename)
      ? compileTypeScript(module, filename)
      : javaScriptHandler.call(this, module, filename);
  }
  extensionHandlers['.js'] = compileTypeScriptReachingJavaScriptHandler;
  patchResolver();
  registerEsmHooks();
}

/** Marks the thread once the module hooks are registered. */
const ESM_MARKER = Symbol.for('lenne.tech/nest-server/ts-compiler/esm');

const TYPESCRIPT = /\.(c|m)?ts$/;
const packageTypes = new Map();

/** `"module"` or `"commonjs"`, from the nearest package.json — how Node itself decides a `.ts` file's format. */
function packageType(directory) {
  if (packageTypes.has(directory)) {
    return packageTypes.get(directory);
  }
  let type = 'commonjs';
  try {
    type =
      JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).type === 'module'
        ? 'module'
        : 'commonjs';
  } catch {
    const parent = path.dirname(directory);
    type = parent === directory ? 'commonjs' : packageType(parent);
  }
  packageTypes.set(directory, type);
  return type;
}

/** The module format Node gives a TypeScript file: `.mts` / `.cts` by extension, `.ts` by the nearest package.json. */
function formatOf(filename) {
  if (filename.endsWith('.mts')) {
    return 'module';
  }
  if (filename.endsWith('.cts')) {
    return 'commonjs';
  }
  return packageType(path.dirname(filename));
}

/**
 * The specifiers to try after an `import` of `./x.js` from a TypeScript file failed: `./x.ts`, `./x.cts` (`./x.mjs`:
 * `./x.mts`). `undefined` when the failure is not of that kind — a real `.js` file always wins, because this is asked
 * only after Node's own resolution failed, and package specifiers are never touched.
 */
function typeScriptSpecifiers(specifier, context, error) {
  const extension = specifier.match(/\.(c|m)?js$/)?.[0];
  const fromTypeScript = TYPESCRIPT.test(context.parentURL ?? '');
  const pathLike = /^\.{0,2}\//.test(specifier) || specifier.startsWith('file:');
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !extension || !fromTypeScript || !pathLike) {
    return undefined;
  }
  const sources = { ...SOURCE_EXTENSIONS, '.mjs': ['.mts'] }[extension] ?? [];
  return sources.map((sourceExtension) => specifier.slice(0, -extension.length) + sourceExtension);
}

/**
 * What the `load` hook answers for a URL, or `undefined` for anything that is not a TypeScript file (Node loads it).
 *
 * A TypeScript file in ESM scope (`.mts`, or `.ts` under `"type": "module"`) is compiled with SWC to ESM, with the
 * options of the CommonJS hook. One in CommonJS scope is handed back to the CommonJS loader WITHOUT a source, where the
 * `require` hook compiles it: the same file must not be compiled two different ways, and only the CommonJS loader gives
 * it a real `require` (`require.cache`, `require.extensions`) — a CommonJS source returned from here crashes Node
 * 22's CommonJS translator and runs with the reduced `require` Node builds for it on 24.13 and earlier.
 */
function loadTypeScript(url) {
  if (!url.startsWith('file:') || !TYPESCRIPT.test(new URL(url).pathname)) {
    return undefined;
  }
  const filename = fileURLToPath(url);
  if (formatOf(filename) === 'commonjs') {
    return { format: 'commonjs', shortCircuit: true };
  }
  swc ??= loadSwc();
  const { code } = swc.transformSync(fs.readFileSync(filename, 'utf8'), {
    ...SWC_OPTIONS,
    filename,
    // SWC drops import attributes unless told to keep them, and Node refuses a JSON import without
    // `with { type: 'json' }` (ERR_IMPORT_ATTRIBUTE_MISSING) — `import pkg from '../package.json' with { type: 'json' }`.
    jsc: { ...SWC_OPTIONS.jsc, experimental: { keepImportAssertions: true } },
    module: { type: 'es6' },
  });
  return { format: 'module', shortCircuit: true, source: code };
}

/** The synchronous `resolve` hook for `module.registerHooks()`; `ts-compiler-hooks.mjs` is its asynchronous twin. */
function resolveHook(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    for (const candidate of typeScriptSpecifiers(specifier, context, error) ?? []) {
      try {
        return nextResolve(candidate, context);
      } catch {
        // try the next one; the original error is the one worth reporting
      }
    }
    throw error;
  }
}

/** The synchronous `load` hook for `module.registerHooks()`; `ts-compiler-hooks.mjs` is its asynchronous twin. */
function loadHook(url, context, nextLoad) {
  return loadTypeScript(url) ?? nextLoad(url, context);
}

/**
 * Whether this Node's `module.registerHooks()` takes a `load` result for a CommonJS module without `source`, i.e. hands
 * it back to the CommonJS loader — what `loadTypeScript()` answers for CommonJS-scoped TypeScript imported from ESM.
 * Measured (tests/unit/ts-compiler.spec.ts): 24.12.0 and 26.0.0 take it; 22.x, 23.x, 24.0–24.11 and 25.0 refuse it
 * with ERR_INVALID_RETURN_PROPERTY_VALUE, and a source compiled for them crashes Node 22 and runs on 24.0–24.11
 * without `require.cache`. Those lines keep `module.register()`, which no Node before 26 deprecates at runtime. 25.x is
 * end-of-life and stays on the older path.
 *
 * @param {string} [version] - A Node version, `process.versions.node` by default.
 */
function registerHooksHandsBackCommonJs(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major >= 26 || (major === 24 && minor >= 12);
}

/**
 * Register the module hooks for `import`ed TypeScript: an ESM project's entry and everything it imports. Without them
 * Node would hand a `.ts` entry to its own type stripping, which cannot lower decorators or emit their metadata —
 * NestJS needs both.
 *
 * `module.registerHooks()` (in-thread, synchronous) where it hands CommonJS back; there it replaces `module.register()`,
 * which Node 26 deprecates at runtime (DEP0205, printed on every start). The CommonJS path needs neither: `require()`
 * of a `.ts` file reaches the extension handler above, which does not consult module hooks.
 *
 * Only on the main thread: `module.register()` runs `ts-compiler-hooks.mjs` on a thread of its own, which loads this
 * file for its helpers and must not register itself again.
 */
function registerEsmHooks() {
  if (!isMainThread || globalThis[ESM_MARKER]) {
    return;
  }
  if (typeof Module.registerHooks === 'function' && registerHooksHandsBackCommonJs()) {
    globalThis[ESM_MARKER] = true;
    Module.registerHooks({ load: loadHook, resolve: resolveHook });
  } else if (typeof Module.register === 'function') {
    globalThis[ESM_MARKER] = true;
    Module.register(pathToFileURL(path.join(__dirname, 'ts-compiler-hooks.mjs')).href);
  }
}

register();

module.exports = register;
module.exports.loadSwc = loadSwc;
module.exports.SWC_OPTIONS = SWC_OPTIONS;
module.exports.SOURCE_EXTENSIONS = SOURCE_EXTENSIONS;
module.exports.loadTypeScript = loadTypeScript;
module.exports.registerHooksHandsBackCommonJs = registerHooksHandsBackCommonJs;
module.exports.typeScriptSpecifiers = typeScriptSpecifiers;
