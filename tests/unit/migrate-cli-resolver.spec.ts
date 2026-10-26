/**
 * Unit Tests: bin/migrate.js CLI path resolution (`resolveCliPath`).
 *
 * The shim must locate the compiled migrate CLI across three layouts (npm package, vendored repo,
 * vendored production image) and fall back to the TypeScript source (through the framework's SWC
 * loader) ONLY when no compiled build exists — compiled candidates are probed first, so a production
 * image with `@swc/core` pruned never picks the source path.
 *
 * `resolveCliPath` is pure with an injectable `existsSync`, and the CLI only runs behind a
 * `require.main === module` guard — so importing the shim here spawns no migration run.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CLI_SUBPATH, resolveCliPath } from '../../bin/migrate.js';

/** `existsSync` stub reporting only the given paths as present. */
const present =
  (...paths: string[]) =>
  (candidate: string) =>
    paths.includes(candidate);

/** Build a compiled-candidate path the same way the resolver does. */
const compiledJs = (dirname: string, ...segments: string[]) => join(dirname, ...segments, `${CLI_SUBPATH}.js`);
const sourceTs = (dirname: string) => join(dirname, '..', 'src', `${CLI_SUBPATH}.ts`);

describe('bin/migrate.js: resolveCliPath', () => {
  it('resolves the npm package layout (bin/ → dist/core/...)', () => {
    const dir = '/pkg/node_modules/@lenne.tech/nest-server/bin';
    const target = compiledJs(dir, '..', 'dist');
    expect(resolveCliPath(dir, present(target))).toMatchObject({ cliPath: target, fromSource: false });
  });

  it('resolves the vendored repo layout (bin/ → dist/src/core/...)', () => {
    const dir = '/proj/bin';
    const target = compiledJs(dir, '..', 'dist', 'src');
    expect(resolveCliPath(dir, present(target))).toMatchObject({ cliPath: target, fromSource: false });
  });

  it('resolves the vendored production image layout (dist/bin/ → dist/src/core/...)', () => {
    const dir = '/proj/dist/bin';
    const target = compiledJs(dir, '..', 'src'); // → /proj/dist/src/core/...
    expect(resolveCliPath(dir, present(target))).toMatchObject({ cliPath: target, fromSource: false });
  });

  it('prefers a compiled candidate over the TypeScript source (never the source when a build exists)', () => {
    const dir = '/proj/bin';
    const compiled = compiledJs(dir, '..', 'dist', 'src');
    expect(resolveCliPath(dir, present(compiled, sourceTs(dir)))).toMatchObject({
      cliPath: compiled,
      fromSource: false,
    });
  });

  it('falls back to the TypeScript source when no compiled build exists', () => {
    const dir = '/proj/bin';
    const source = sourceTs(dir);
    expect(resolveCliPath(dir, present(source))).toMatchObject({ cliPath: source, fromSource: true });
  });

  it('returns cliPath null and lists every probed path when nothing exists', () => {
    const dir = '/proj/bin';
    const result = resolveCliPath(dir, () => false);
    expect(result.cliPath).toBeNull();
    expect(result.fromSource).toBe(false);
    // 3 compiled candidates + 1 source path, surfaced in the not-found diagnostic.
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates).toContain(sourceTs(dir));
  });
});
