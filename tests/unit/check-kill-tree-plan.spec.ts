import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { killTreePlan } from '../../scripts/check.mjs';

/**
 * The `check` watchdog kills a wedged step's whole process tree. On POSIX it collects the
 * children via `pgrep -P` and signals them leaves-first; Windows has neither `pgrep` nor
 * signals, so that path ends only the shell and leaves vitest orphaned — exactly when the
 * watchdog is supposed to clean up a hung run.
 *
 * Every case here checks the PLAN, never the effect: no test sends a real signal or runs a
 * real `taskkill`. A test that injects the platform but lets the signal path run for real
 * is testing this machine, not the code (a `process.kill(-1, …)` from such a test rebooted
 * a developer's Mac on 2026-09-23).
 *
 * @regression   11.41.3 — `killTree()` in scripts/check.mjs used `pgrep` + `process.kill`
 *   on every platform, so on Windows the watchdog killed only the shell and orphaned the
 *   vitest tree it was meant to end.
 * @seen-failing Make `killTreePlan()` return the POSIX plan on win32 — registered as mutation
 *   `check-kill-tree-plan-no-win32` in tests/regression-mutations.json; and drop the early
 *   `return` after `taskkill` in `killTree()` — registered as `check-kill-tree-falls-through-to-pgrep`.
 */
describe('check.mjs: killTreePlan', () => {
  it('force-kills the whole tree with taskkill on Windows', () => {
    expect(killTreePlan(4321, 'SIGTERM', 'win32')).toEqual({
      args: ['/PID', '4321', '/T', '/F'],
      command: 'taskkill',
    });
  });

  it('keeps /F even for the polite signal, because Windows has no polite stage', () => {
    // `taskkill /T` without `/F` was measured to leave the tree running with the port held.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      expect(killTreePlan(1, signal, 'win32').args).toContain('/F');
    }
  });

  it('passes the signal through on POSIX and names no command', () => {
    expect(killTreePlan(4321, 'SIGTERM', 'linux')).toEqual({ signal: 'SIGTERM' });
    expect(killTreePlan(4321, 'SIGKILL', 'darwin')).toEqual({ signal: 'SIGKILL' });
  });

  it('killTree() runs the taskkill plan and returns before reaching pgrep', () => {
    // killTree() itself is not callable without real effects, so its dispatch is checked by
    // reading it: a pure plan nobody consults, or a call site that falls through to the
    // pgrep/process.kill path after taskkill, would leave Windows exactly where it was.
    const source = readFileSync(join(__dirname, '..', '..', 'scripts', 'check.mjs'), 'utf8');
    const body = source.slice(source.indexOf('function killTree('), source.indexOf('\nfunction capture('));
    expect(body).toContain('killTreePlan(child.pid, signal)');
    expect(body).toMatch(
      /if \(plan\.command\) \{[\s\S]*?execFileSync\(plan\.command, plan\.args[\s\S]*?\n {4}return;\n {2}\}[\s\S]*pgrep -P/,
    );
  });
});
