/**
 * Forwarder kept at the path existing projects load (`migrations-utils/migrate.js`, which the lt CLI generates for
 * vendor-mode projects, requires `src/core/modules/migrate/helpers/migration.helper`). The helper itself moved to
 * `../migration.helper.ts` in 12.0.0.
 *
 * This directory is CommonJS (`helpers/package.json`), so this file compiles to CommonJS. No module of the core may
 * import it: a CommonJS module inside the core's ES module graph that loads other core modules breaks `require()` of
 * the package from a CommonJS project. Core modules import `../migration.helper.js`.
 */
export * from '../migration.helper.js';
