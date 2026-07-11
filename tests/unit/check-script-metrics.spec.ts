/**
 * Unit Tests: `scripts/check.mjs` metric parsing.
 *
 * `parseVitest()` turns a test step's captured stdout into the counts the check report prints.
 * Since `test` is `vitest:unit && vitest`, a single step emits TWO vitest summary blocks — and
 * the printed test count is the only evidence in the report that a suite ran at all. A parser
 * that reads just the first block reports a green check while silently dropping the e2e suite.
 *
 * These fixtures are verbatim vitest summary shapes (non-TTY, ANSI-stripped by the parser).
 */
import { describe, expect, it } from 'vitest';

import { parseVitest } from '../../scripts/check.mjs';

const UNIT_RUN = ' Test Files  16 passed (16)\n      Tests  646 passed (646)\n';
const E2E_RUN = ' Test Files  51 passed (51)\n      Tests  1380 passed (1380)\n';
const DURATION = '   Duration  5.25s (transform 5.96s, setup 0ms, import 34.08s, tests 5.88s, environment 1ms)\n';

describe('check.mjs: parseVitest', () => {
  it('should sum the summary blocks of every vitest run in one step', () => {
    expect(parseVitest(UNIT_RUN + DURATION + E2E_RUN + DURATION)).toEqual({
      failed: 0,
      files: 67,
      passed: 2026,
    });
  });

  it('should read a single run', () => {
    expect(parseVitest(UNIT_RUN)).toEqual({ failed: 0, files: 16, passed: 646 });
  });

  it('should sum failures across runs and keep the passed counts', () => {
    const failingE2e = ' Test Files  1 failed | 50 passed (51)\n      Tests  2 failed | 1378 passed (1380)\n';
    expect(parseVitest(UNIT_RUN + failingE2e)).toEqual({ failed: 2, files: 66, passed: 2024 });
  });

  it('should read the passed count past interleaved todo/skipped segments', () => {
    expect(parseVitest('      Tests  1 failed | 2 todo | 643 passed (646)\n')).toMatchObject({
      failed: 1,
      passed: 643,
    });
  });

  it('should strip ANSI colour codes before matching', () => {
    expect(parseVitest(` Test Files  \x1b[1m\x1b[32m16 passed\x1b[0m (16)\n      Tests  \x1b[32m646 passed\x1b[0m (646)\n`))
      .toEqual({ failed: 0, files: 16, passed: 646 });
  });

  // The `Duration` line contains a lowercase "tests 5.88s"; the regexes are case-insensitive, so
  // a sloppy pattern would pick a number out of it.
  it('should not read counts out of the duration line', () => {
    expect(parseVitest(DURATION)).toBeNull();
  });

  // No "N passed" anywhere → no metrics to show, rather than a misleading zero.
  it('should return null when a run reports no passing tests', () => {
    expect(parseVitest(' Test Files  1 failed (1)\n      Tests  3 failed (3)\n')).toBeNull();
  });

  it('should return null for output without a summary block', () => {
    expect(parseVitest('')).toBeNull();
    expect(parseVitest('some unrelated build output\n')).toBeNull();
  });

  // Importing check.mjs must not kick off a check run — `main()` runs only when
  // INVOKED_AS_SCRIPT (`resolve(process.argv[1]) === check.mjs`). Under vitest, argv[1] is the
  // runner, so the guard is false and the top-of-file import above did not spawn a check run
  // (a spawned run would have hung/failed this file). Assert the guard's premise directly, not
  // just that the export exists.
  it('should not execute the pipeline on import (argv guard holds under vitest)', () => {
    const runner = process.argv[1] ?? '';
    expect(runner).not.toMatch(/check\.mjs$/);
    expect(typeof parseVitest).toBe('function');
  });
});
