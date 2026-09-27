/**
 * Proves the signal guard is armed in this worker and refuses what it must.
 *
 * Importing `./signal-guard` installs nothing, so "installed" here can only come from the
 * vitest setup file (`signal-guard.setup.ts` in `setupFiles`). Drop that entry and every
 * wiring test below turns red.
 *
 * The probe pid is 2^30, above any pid_max: without the guard `process.kill` would only fail
 * with ESRCH, so the guard's own message is what shows the refusal came from the guard.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { guardInstalled, signalVerdict, takeViolations } from './signal-guard';

const PROBE = 2 ** 30;

describe('signal guard — wiring', () => {
  it('is installed for this worker by the vitest setup file', () => {
    expect(guardInstalled()).toBe(true);
  });

  it('refuses a real signal to a pid this worker did not spawn', () => {
    expect(() => process.kill(PROBE, 'SIGTERM')).toThrow(/signal-guard: .*was not spawned by this test worker/);
    expect(takeViolations()).toHaveLength(1);
  });

  it('records a refusal even when the caller swallows it, so afterEach can fail the test', () => {
    try {
      process.kill(PROBE, 'SIGTERM');
    } catch {
      /* swallowed, the way killTree swallows it */
    }
    expect(takeViolations()).toEqual([expect.stringMatching(/was not spawned by this test worker/)]);
  });

  it('lets signal 0 through — a probe delivers nothing', () => {
    expect(process.kill(process.pid, 0)).toBe(true);
  });

  it('lets a real signal reach a child this worker spawned', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const exited = once(child, 'exit');

    process.kill(child.pid!, 'SIGTERM');

    // The signal arrived and ended the child; how Windows reports that differs from POSIX.
    const [code, signal] = await exited;
    expect(code !== null || signal !== null).toBe(true);
    expect(takeViolations()).toEqual([]);
  });
});

describe('signalVerdict', () => {
  const spawned = new Set([4321]);

  it.each([
    [-1, 'every process of a group or of the user'],
    [0, 'every process of a group or of the user'],
    [Number.NaN, 'is not an integer'],
    ['4321', 'is not an integer'],
    [1234, 'pid 1234 was not spawned'],
    [-1234, 'process group 1234 was not spawned'],
  ])('refuses pid %s', (pid, reason) => {
    expect(signalVerdict(pid, 'SIGTERM', spawned)).toContain(reason);
  });

  it('allows a spawned pid and its group, and any signal 0', () => {
    expect(signalVerdict(4321, 'SIGKILL', spawned)).toBeNull();
    expect(signalVerdict(-4321, 'SIGTERM', spawned)).toBeNull();
    expect(signalVerdict(-1, 0, spawned)).toBeNull();
  });
});
