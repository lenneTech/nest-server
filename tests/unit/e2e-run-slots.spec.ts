import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireRunSlot, activeRuns, countOtherActiveRuns, maxConcurrentE2eRuns, slotDir } from '../e2e-run-slots';

/**
 * Unit tests for the machine-wide e2e run governor (tests/e2e-run-slots.ts).
 *
 * The governor is what keeps parallel `lt dev` / `lt ticket` sessions from starving
 * each other's e2e runs, and its crash-recovery (PID-liveness reclaim) is what keeps
 * a SIGKILLed run from blocking every later one — both are worth pinning down.
 */
describe('e2e-run-slots', () => {
  let dir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['LT_E2E_SLOT_DIR', 'LT_E2E_MAX_RUNS', 'LT_E2E_SLOT_TIMEOUT']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    dir = mkdtempSync(join(os.tmpdir(), 'e2e-slots-test-'));
    process.env.LT_E2E_SLOT_DIR = dir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { force: true, recursive: true });
  });

  it('resolves the slot dir from the env override', () => {
    expect(slotDir()).toBe(dir);
  });

  it('respects LT_E2E_MAX_RUNS including 0 (governor disabled)', () => {
    process.env.LT_E2E_MAX_RUNS = '3';
    expect(maxConcurrentE2eRuns()).toBe(3);
    process.env.LT_E2E_MAX_RUNS = '0';
    expect(maxConcurrentE2eRuns()).toBe(0);
    delete process.env.LT_E2E_MAX_RUNS;
    expect(maxConcurrentE2eRuns()).toBeGreaterThanOrEqual(1);
  });

  it('acquires and releases a slot file for the own process', async () => {
    const release = await acquireRunSlot({ maxRuns: 2, pollMs: 5 });
    expect(existsSync(join(dir, `${process.pid}.slot`))).toBe(true);
    expect(activeRuns().map((s) => s.pid)).toContain(process.pid);
    expect(countOtherActiveRuns()).toBe(0);
    release();
    expect(existsSync(join(dir, `${process.pid}.slot`))).toBe(false);
  });

  it('reclaims slot files of dead processes', () => {
    // A PID far above any real one on this machine — kill(pid, 0) throws ESRCH.
    writeFileSync(join(dir, '99999999.slot'), JSON.stringify({ pid: 99999999, startedAt: Date.now() }));
    expect(activeRuns()).toHaveLength(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('counts a live foreign slot and waits for it, then proceeds fail-open after the timeout', async () => {
    // The parent process (vitest main / shell) is alive for the duration of the test.
    const foreignPid = process.ppid;
    writeFileSync(join(dir, `${foreignPid}.slot`), JSON.stringify({ pid: foreignPid, startedAt: Date.now() }));
    expect(countOtherActiveRuns()).toBe(1);

    const logs: string[] = [];
    const release = await acquireRunSlot({
      log: (m) => logs.push(m),
      logEveryMs: 10,
      maxRuns: 1,
      pollMs: 10,
      timeoutMs: 120,
    });
    expect(logs.some((m) => m.includes('waiting for a free e2e slot'))).toBe(true);
    expect(logs.some((m) => m.includes('fail-open'))).toBe(true);
    // Fail-open still claims a slot so later runs see the true concurrency.
    expect(existsSync(join(dir, `${process.pid}.slot`))).toBe(true);
    release();
  });

  it('acquires immediately when a slot is free even with foreign runs present', async () => {
    const foreignPid = process.ppid;
    writeFileSync(join(dir, `${foreignPid}.slot`), JSON.stringify({ pid: foreignPid, startedAt: Date.now() }));

    const logs: string[] = [];
    const release = await acquireRunSlot({ log: (m) => logs.push(m), maxRuns: 2, pollMs: 5 });
    expect(logs).toHaveLength(0);
    expect(activeRuns()).toHaveLength(2);
    release();
    expect(activeRuns()).toHaveLength(1);
  });

  it('is a no-op when the governor is disabled via maxRuns 0', async () => {
    const release = await acquireRunSlot({ maxRuns: 0 });
    expect(readdirSync(dir)).toHaveLength(0);
    release();
  });
});
