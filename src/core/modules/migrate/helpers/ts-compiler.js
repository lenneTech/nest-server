/**
 * Entry point of the framework's TypeScript loader — the path `--compiler ts:…` and `node -r …` name.
 *
 * CommonJS in every project: `helpers/package.json` declares `"type": "commonjs"` for this directory, so the file keeps
 * its format inside this ESM package (12.0.0+) and inside an ESM vendor project alike, and the established path and
 * its function export stay the contract they have always been. The implementation lives in `ts-compiler.cjs`; see
 * there for what the loader does.
 */
'use strict';

module.exports = require('./ts-compiler.cjs');
