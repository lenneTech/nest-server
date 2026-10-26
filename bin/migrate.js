#!/usr/bin/env node

/**
 * Migration CLI wrapper
 *
 * This is a shim that makes the nest-server migration CLI available as "migrate"
 * for drop-in compatibility with projects using the @nodepit/migrate package.
 *
 * The same file has to work from three locations, because `lt fullstack
 * convert-mode` copies it verbatim into vendored projects:
 *
 *   npm mode     node_modules/@lenne.tech/nest-server/bin/  → ../dist/core/**.js
 *   vendor repo  <project>/bin/                             → ../dist/src/core/**.js
 *                                                             (or ../src/core/**.ts from source)
 *   vendor image <project>/dist/bin/                        → ../src/core/**.js
 *
 * Compiled candidates are probed first, so a production image never reaches the
 * source branch — its TypeScript loader needs `@swc/core`, a devDependency that
 * gets pruned there.
 *
 * NOTE on the vendored-image layout: it assumes the build preserves the `src/`
 * prefix (`dist/src/core/...`, matching `lt fullstack convert-mode`). A project
 * that instead flattens `rootDir: 'src'` to `dist/core/...` is still resolved in
 * *repo* mode (candidate 1) but not from the `dist/bin/` image variant.
 *
 * The resolver is exported (and pure, with an injectable `existsSync`) so the
 * three-layout probe + not-found branch can be unit-tested without spawning a
 * migration run; the CLI only executes when this file is invoked directly.
 */

const fs = require('fs');
const path = require('path');

const CLI_SUBPATH = 'core/modules/migrate/cli/migrate-cli';

/**
 * Resolve the migrate CLI entry across the npm + vendored layouts.
 *
 * Compiled `.js` candidates (most specific first) are probed before the TypeScript
 * source, so a production image with `@swc/core` pruned never picks the source path.
 *
 * @param {string} dirname - Directory of the shim (`__dirname` at runtime).
 * @param {(p: string) => boolean} [existsSync] - Injected for tests; defaults to `fs.existsSync`.
 * @returns {{ cliPath: string | null, fromSource: boolean, candidates: string[] }}
 *   `cliPath` is the resolved entry (null when nothing matched); `fromSource` is true only for the
 *   TypeScript-source fallback, which needs the TypeScript loader; `candidates` is every path probed,
 *   for the not-found diagnostic.
 */
function resolveCliPath(dirname, existsSync = fs.existsSync) {
  const compiledCandidates = [
    // npm package layout: bin/ → dist/core/...
    path.join(dirname, '..', 'dist', `${CLI_SUBPATH}.js`),
    // vendored build output: dist/bin/ → dist/src/core/...
    path.join(dirname, '..', 'src', `${CLI_SUBPATH}.js`),
    // vendored repo root: bin/ → dist/src/core/...
    path.join(dirname, '..', 'dist', 'src', `${CLI_SUBPATH}.js`),
  ];
  // TypeScript source, used for local development through the TypeScript loader.
  const sourcePath = path.join(dirname, '..', 'src', `${CLI_SUBPATH}.ts`);
  const candidates = [...compiledCandidates, sourcePath];

  const compiled = compiledCandidates.find((candidate) => existsSync(candidate));
  if (compiled) {
    return { candidates, cliPath: compiled, fromSource: false };
  }
  if (existsSync(sourcePath)) {
    return { candidates, cliPath: sourcePath, fromSource: true };
  }
  return { candidates, cliPath: null, fromSource: false };
}

module.exports = { CLI_SUBPATH, resolveCliPath };

// Only run the CLI when invoked directly (`node bin/migrate.js` / the `migrate` bin).
// Importing this module for tests must not spawn a migration run.
if (require.main === module) {
  const { candidates, cliPath, fromSource } = resolveCliPath(__dirname);

  if (!cliPath) {
    console.error('Error: Migration CLI not found. Looked for:');
    for (const candidate of candidates) {
      console.error(`  - ${candidate}`);
    }
    process.exit(1);
  }

  if (fromSource) {
    // Development: register the framework's TypeScript loader (SWC), which sits next to the CLI source.
    try {
      require(path.join(path.dirname(cliPath), '..', 'helpers', 'ts-compiler.js'));
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }

  // Load and run the CLI.
  //
  // Prefer runCli(): it drains stdout and then exits explicitly, so a handle left
  // behind by MongoDB/GridFS cannot keep the process alive after the work is done
  // (a migration step that never returns blocks the container before the server
  // ever starts). main() is the fallback for a dist built before runCli existed —
  // it resolves normally but relies on the event loop draining by itself.
  const cli = require(cliPath);
  const run = cli.runCli || cli.main;
  Promise.resolve(run()).catch((error) => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
  });
}
