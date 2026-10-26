import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireRunSlot, activeRuns, countOtherActiveRuns, maxConcurrentE2eRuns, slotDir } from '../e2e-run-slots.mjs';

/**
 * Unit tests for the machine-wide e2e run governor (tests/e2e-run-slots.mts).
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

  /**
   * @regression   11.42.x — a slot was reclaimed by PID liveness alone, so a slot whose PID had been
   *   recycled by an unrelated long-lived process was counted as an active run forever and never
   *   unlinked. Every later run on the machine then dropped into low-resource mode or waited out
   *   the full fail-open timeout.
   * @seen-failing Disable the age cap in activeRuns() in tests/e2e-run-slots.mts — registered as
   *   mutation `e2e-slot-no-age-cap` in tests/regression-mutations.json.
   */
  it('reclaims a slot whose PID is alive but whose age says it cannot be a run (PID recycling)', () => {
    // `process.ppid` is alive for the duration of this test, so the only thing that can free this
    // slot is the age cap.
    const foreignPid = process.ppid;
    const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
    writeFileSync(join(dir, `${foreignPid}.slot`), JSON.stringify({ pid: foreignPid, startedAt: sevenHoursAgo }));

    expect(activeRuns()).toHaveLength(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('keeps a live slot that is inside the age cap', () => {
    // The refusal case for the test above: an age cap that reclaims everything would pass it too.
    const foreignPid = process.ppid;
    writeFileSync(join(dir, `${foreignPid}.slot`), JSON.stringify({ pid: foreignPid, startedAt: Date.now() - 60_000 }));

    expect(activeRuns().map((s) => s.pid)).toContain(foreignPid);
  });

  // The two tests below must create the slot directory THEMSELVES or plant the link THEMSELVES:
  // `dir` comes from mkdtempSync, which is always 0700 and always empty, so asserting on it proves
  // nothing. Both are skipped on Windows, which has no POSIX permission bits (`statSync().mode`
  // reports 0o666-style values regardless of what mkdirSync was asked for) and allows symlinks only
  // with an extra privilege. The hardened code itself runs there unchanged.

  /**
   * @regression   11.42.x — the slot directory is shared by every lt project on the machine, and on
   *   a multi-user Linux host `os.tmpdir()` is the world-writable `/tmp`. It was created without a
   *   mode and the slot file written with flag 'w', so a `<pid>.slot` symlink planted by another
   *   user made the write truncate the link's target and fill it with the slot JSON.
   * @seen-failing Restore the bare `mkdirSync` + flag 'w' write in claimOwnSlot() in
   *   tests/e2e-run-slots.mts — registered as mutation `e2e-slot-claim-follows-symlink` in
   *   tests/regression-mutations.json.
   */
  it.skipIf(process.platform === 'win32')('creates a missing slot directory private (0700)', async () => {
    const slots = join(dir, 'slots');
    process.env.LT_E2E_SLOT_DIR = slots;

    const release = await acquireRunSlot({ maxRuns: 2, pollMs: 5 });
    try {
      expect(statSync(slots).mode & 0o777).toBe(0o700);
    } finally {
      release();
    }
  });

  /**
   * @regression   11.42.x — see the 0700 case above: same defect, the half that writes through the
   *   planted link.
   * @seen-failing Restore the bare `mkdirSync` + flag 'w' write in claimOwnSlot() in
   *   tests/e2e-run-slots.mts — registered as mutation `e2e-slot-claim-follows-symlink` in
   *   tests/regression-mutations.json.
   */
  it.skipIf(process.platform === 'win32')('does not follow a symlink planted at the own slot path', async () => {
    const slots = join(dir, 'slots');
    mkdirSync(slots);
    process.env.LT_E2E_SLOT_DIR = slots;
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'PRECIOUS');
    const slot = join(slots, `${process.pid}.slot`);
    symlinkSync(victim, slot);

    const release = await acquireRunSlot({ maxRuns: 2, pollMs: 5 });
    try {
      // A followed write would have truncated the target and put the slot JSON into it.
      expect(readFileSync(victim, 'utf8')).toBe('PRECIOUS');
      expect(lstatSync(slot).isSymbolicLink()).toBe(false);
    } finally {
      release();
    }
  });

  /**
   * @regression   11.42.x — fail-open is this module's stated contract, but a slot that could not be
   *   written (another user owns the directory on a shared host, a read-only tmpdir) threw out of
   *   acquireRunSlot() and, through tests/global-setup.ts, aborted the whole e2e suite.
   * @seen-failing Rethrow from the catch around claimOwnSlot() in acquireRunSlot() in
   *   tests/e2e-run-slots.mts, i.e. the old unguarded call — registered as mutation
   *   `e2e-slot-claim-not-fail-open` in tests/regression-mutations.json.
   */
  it('proceeds without the governor instead of killing the run when no slot can be written', async () => {
    process.env.LT_E2E_SLOT_DIR = join(dir, 'not-a-directory', 'nested');
    writeFileSync(join(dir, 'not-a-directory'), 'a file, so mkdir below it must fail');

    const logs: string[] = [];
    const release = await acquireRunSlot({ log: (m) => logs.push(m), maxRuns: 2, pollMs: 5 });
    expect(logs.some((m) => m.includes('proceeding without the governor'))).toBe(true);
    expect(() => release()).not.toThrow();
  });
});
