/**
 * Vitest setup file: arms the signal guard for every unit test file (see signal-guard.ts).
 *
 * Kept apart from the guard's own module on purpose: the wiring test imports signal-guard.ts,
 * and if that import installed the guard, the test would find it installed even with this
 * file dropped from `setupFiles` — the one regression it exists to catch.
 */
import { afterEach } from 'vitest';

import { installSignalGuard, takeViolations } from './signal-guard';

installSignalGuard();

// Throwing alone is not enough: code under test that wraps `process.kill` in a try/catch
// (as killTree does) would swallow the refusal and the test would pass. So a refused signal
// also fails the test it happened in.
afterEach(() => {
  const found = takeViolations();
  if (found.length === 0) return;
  throw new Error(`${found.length} refused signal(s) in this test:\n${found.join('\n')}`);
});
