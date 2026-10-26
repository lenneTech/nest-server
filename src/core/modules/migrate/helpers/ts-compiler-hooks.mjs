/**
 * ESM hooks of the framework's TypeScript loader, registered by `ts-compiler.cjs` through `module.register()`.
 *
 * - `resolve`: a relative `./x.js` from a TypeScript file finds `x.ts` when no `x.js` exists (ESM requires the
 *   extension of the EMITTED file, so sources written for both module systems name files that exist only after a
 *   build). A real `.js` file always wins.
 * - `load`: a TypeScript file in ESM scope (`.mts`, or `.ts` under `"type": "module"`) is compiled with SWC to ESM,
 *   with the options of the CommonJS hook. One in CommonJS scope is handed back to the CommonJS loader, where the
 *   `require` hook compiles it — the same file must not be compiled two different ways.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadSwc, SOURCE_EXTENSIONS, SWC_OPTIONS } = require('./ts-compiler.cjs');

const TYPESCRIPT = /\.(c|m)?ts$/;
const packageTypes = new Map();
let swc;

/** `"module"` or `"commonjs"`, from the nearest package.json — how Node itself decides a `.ts` file's format. */
function packageType(directory) {
  if (packageTypes.has(directory)) {
    return packageTypes.get(directory);
  }
  let type = 'commonjs';
  try {
    type = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).type === 'module' ? 'module' : 'commonjs';
  } catch {
    const parent = dirname(directory);
    type = parent === directory ? 'commonjs' : packageType(parent);
  }
  packageTypes.set(directory, type);
  return type;
}

function formatOf(filename) {
  if (filename.endsWith('.mts')) {
    return 'module';
  }
  if (filename.endsWith('.cts')) {
    return 'commonjs';
  }
  return packageType(dirname(filename));
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const extension = specifier.match(/\.(c|m)?js$/)?.[0];
    const fromTypeScript = TYPESCRIPT.test(context.parentURL ?? '');
    const pathLike = /^\.{0,2}\//.test(specifier) || specifier.startsWith('file:');
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !extension || !fromTypeScript || !pathLike) {
      throw error;
    }
    const sources = { ...SOURCE_EXTENSIONS, '.mjs': ['.mts'] }[extension] ?? [];
    for (const sourceExtension of sources) {
      try {
        return await nextResolve(specifier.slice(0, -extension.length) + sourceExtension, context);
      } catch {
        // try the next one; the original error is the one worth reporting
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !TYPESCRIPT.test(new URL(url).pathname)) {
    return nextLoad(url, context);
  }
  const filename = fileURLToPath(url);
  if (formatOf(filename) === 'commonjs') {
    // No source: Node loads it with the CommonJS loader, i.e. through the `require` hook.
    return { format: 'commonjs', shortCircuit: true };
  }
  swc ??= loadSwc();
  const { code } = swc.transformSync(readFileSync(filename, 'utf8'), {
    ...SWC_OPTIONS,
    filename,
    // SWC drops import attributes unless told to keep them, and Node refuses a JSON import without
    // `with { type: 'json' }` (ERR_IMPORT_ATTRIBUTE_MISSING) — `import pkg from '../package.json' with { type: 'json' }`.
    jsc: { ...SWC_OPTIONS.jsc, experimental: { keepImportAssertions: true } },
    module: { type: 'es6' },
  });
  return { format: 'module', shortCircuit: true, source: code };
}
