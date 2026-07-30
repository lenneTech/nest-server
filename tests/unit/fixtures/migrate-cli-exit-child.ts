/**
 * Fixture for `migrate-cli-exit.spec.ts`.
 *
 * Reproduces both halves of the situation the CLI's exit path exists for:
 *
 * 1. A leaked handle. `setInterval` without `unref()` stands in for the MongoDB /
 *    GridFS / state-store connections a migration leaves behind — without an
 *    explicit exit the process would run forever here.
 * 2. More buffered output than a pipe can hold. `process.exit()` does not drain
 *    stdout, so a naive exit truncates everything past the ~64 KiB pipe buffer,
 *    including the last line — which is what CI greps for.
 *
 * Prints a sentinel as the very last line so the test can assert nothing was cut.
 *
 * Writes via `process.stdout.write` rather than `console.log` ON PURPOSE: the
 * repo's lint auto-fix strips `console.*` calls here, which would silently empty
 * this fixture and leave a test that passes against no output at all. The direct
 * write is also exactly what the CLI's own drain operates on.
 */

import { flushAndExit } from '../../../src/core/modules/migrate/cli/migrate-cli';

// The leak. Deliberately NOT unref'd.
setInterval(() => undefined, 1000);

const lines = Number(process.env.FIXTURE_LINES || 20000);
for (let i = 0; i < lines; i++) {
  process.stdout.write(`line-${i}-padding-padding-padding-padding-padding-padding\n`);
}
process.stdout.write('SENTINEL-LAST-LINE\n');

void flushAndExit(0);
