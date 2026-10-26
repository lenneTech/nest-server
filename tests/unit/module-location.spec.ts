import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { callerDirectory } from '../../src/core/common/helpers/module-location.helper';

/**
 * `callerDirectory()` reads the calling file from the V8 stack — the core's replacement for `__dirname`, which exists in
 * only one module system. Where the frame names its file decides the branch: the published package is an ES module
 * since 12.0.0, and an ES module's frame carries a `file:` URL, while a CommonJS build and vitest carry a plain path.
 * Both callers are simulated with `runInThisContext`, whose `filename` becomes the frame's file name.
 *
 * @regression   12.0.0 (pre-release) — production takes the `file:` branch (mail templates, Hub email preview,
 *   uploadFileToGridFS), and every suite took the other one (found by the 12.0.0 review's test reviewer).
 * @seen-failing Drop the fileURLToPath() branch from callerDirectory() in
 *   src/core/common/helpers/module-location.helper.ts — registered as mutation `caller-directory-file-url` in
 *   tests/regression-mutations.json.
 */
const callerFile = join(tmpdir(), 'module-location-probe', 'dist', 'caller.js');

function callFrom(filename: string): string {
  const caller = runInThisContext('(fn) => fn(0)', { filename }) as (fn: typeof callerDirectory) => string;
  return caller(callerDirectory);
}

describe('callerDirectory()', () => {
  it('returns the directory of a caller whose frame is a file: URL (an ES module)', () => {
    expect(callFrom(pathToFileURL(callerFile).href)).toBe(dirname(callerFile));
  });

  it('returns the directory of a caller whose frame is a plain path (CommonJS)', () => {
    expect(callFrom(callerFile)).toBe(dirname(callerFile));
  });
});
