import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory of the file that calls this function — the replacement for `__dirname` in the core.
 *
 * The core's source must be valid as CommonJS (this package, CommonJS projects) AND as ESM (ESM projects that
 * vendor it). `__dirname` exists only in CommonJS, `import.meta.dirname` only in ESM, and `tsc` refuses
 * `import.meta` in a file it emits as CommonJS (TS1470) — so neither can be written in source that has to be
 * both. V8 knows the calling file either way: as a path (CommonJS, and a TypeScript source run) or as a `file:`
 * URL (ESM).
 *
 * Call it synchronously from the module whose location you need — after an `await` the caller's frame is gone.
 *
 * @param depth how many further frames up to go: 0 = the caller, 1 = the caller's caller (for a helper that
 *   resolves paths on behalf of whoever called IT)
 */
export function callerDirectory(depth = 0): string {
  const original = Error.prepareStackTrace;
  let file: null | string | undefined;
  try {
    Error.prepareStackTrace = (_error, frames) => frames;
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder, callerDirectory);
    file = (holder.stack as NodeJS.CallSite[] | undefined)?.[depth]?.getFileName();
  } finally {
    Error.prepareStackTrace = original;
  }
  if (!file) {
    throw new Error(`callerDirectory(): no calling file at depth ${depth}`);
  }
  return dirname(file.startsWith('file:') ? fileURLToPath(file) : file);
}
