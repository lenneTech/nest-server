/**
 * Toolchain version combinations that are known to break the test run itself.
 *
 * vitest 5.0.5 reads the modules it evaluates in the MAIN process — globalSetup and reporters, i.e.
 * `tests/global-setup.ts` and `tests/db-lifecycle.reporter.ts` — as a Buffer, and Vite 8.3.5 started
 * calling `code.charCodeAt()` on that code when it maps a stack trace. From then on, reading the
 * `.stack` of ANY error created in the main process throws `TypeError: code.charCodeAt is not a
 * function`. Here that happens when the MongoDB driver's monitor reports a reset while the
 * reporter closes its connection after the DB cleanup: every test green, and the run still exits 1
 * (observed 2026-10-24, 1 run in 3). Upstream: vitest-dev/vitest#11682 (fixed on main, not in
 * 5.0.5). Vite 8.3.4 is the documented workaround.
 *
 * Delete this spec once vitest ships the fix (a release after 5.0.5), and raise `vite` with it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

function parse(version: string): number[] {
  return version.split('-')[0].split('.').map(Number);
}

function atLeast(version: string, floor: string): boolean {
  const [a, b] = [parse(version), parse(floor)];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] > b[i];
    }
  }
  return true;
}

describe('toolchain compatibility', () => {
  it('does not combine vitest <= 5.0.5 with vite >= 8.3.5 (vitest-dev/vitest#11682)', () => {
    const vitest = pkg.devDependencies.vitest as string;
    const vite = pkg.devDependencies.vite as string;
    const vitestHasFix = atLeast(vitest, '5.0.6');
    expect(
      vitestHasFix || !atLeast(vite, '8.3.5'),
      `vitest ${vitest} + vite ${vite}: main-process stack traces crash the run — keep vite at 8.3.4`,
    ).toBe(true);
  });
});
