/**
 * Asynchronous module hooks of the framework's TypeScript loader, registered by `ts-compiler.cjs` through
 * `module.register()` on the Node lines whose `module.registerHooks()` cannot hand CommonJS back to the CommonJS loader
 * (22.x, 24.0–24.11, 25.x; see `registerHooksHandsBackCommonJs()`). Newer lines run the synchronous twins in
 * `ts-compiler.cjs` in-thread instead, and this file is not loaded there.
 *
 * Both share one implementation in `ts-compiler.cjs`, so the two paths cannot drift:
 *
 * - `resolve`: a relative `./x.js` from a TypeScript file finds `x.ts` when no `x.js` exists (ESM requires the
 *   extension of the EMITTED file, so sources written for both module systems name files that exist only after a
 *   build). A real `.js` file always wins.
 * - `load`: a TypeScript file in ESM scope (`.mts`, or `.ts` under `"type": "module"`) is compiled with SWC to ESM. One
 *   in CommonJS scope is handed back to the CommonJS loader, where the `require` hook compiles it.
 *
 * Runs on the hooks thread `module.register()` creates; loading `ts-compiler.cjs` there registers no hooks again.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadTypeScript, typeScriptSpecifiers } = require('./ts-compiler.cjs');

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    for (const candidate of typeScriptSpecifiers(specifier, context, error) ?? []) {
      try {
        return await nextResolve(candidate, context);
      } catch {
        // try the next one; the original error is the one worth reporting
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  return loadTypeScript(url) ?? nextLoad(url, context);
}
