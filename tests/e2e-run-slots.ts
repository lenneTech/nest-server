import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

/**
 * Machine-wide e2e run governor.
 *
 * Problem this solves: every `lt dev` / `lt ticket` session that runs `check` starts a full
 * e2e suite, and vitest's default fork count assumes an EXCLUSIVE machine (`numCpus - 1`).
 * Two overlapping full-speed runs saturate the box (measured: load 30 on 12 cores), requests
 * queue past the testTimeout, auth queries come back as spurious 401s, and one of the runs
 * fails — pure resource starvation that reads like product bugs. The load-average heuristic
 * in vitest-e2e.config.ts cannot protect against this alone: the 1-minute average lags a
 * 30-60s test run, so two runs STARTING together both see an idle machine.
 *
 * Mechanism: a cross-process slot directory in the OS temp dir, shared by ALL lt projects on
 * the machine. Each running e2e suite holds one slot file (`<pid>.slot`); further runs wait
 * until a slot frees up. Crash-safety needs no daemon: slots are reclaimed by PID-liveness
 * checks, so a SIGKILLed run (check.mjs watchdog, closed terminal) never blocks anyone.
 *
 * While waiting, a log line is emitted every 15s — this doubles as a keep-alive for the
 * check.mjs no-output watchdog (300s), so a queued run is never mistaken for a deadlock.
 *
 * Env overrides:
 *   LT_E2E_MAX_RUNS=<n>      number of concurrent e2e runs machine-wide (default: 2 on >=8
 *                            cores, else 1; 0 disables the governor entirely)
 *   LT_E2E_SLOT_DIR=<path>   slot directory (default: <tmpdir>/lt-e2e-run-slots)
 *   LT_E2E_SLOT_TIMEOUT=<s>  max seconds to wait for a slot before proceeding anyway
 *                            (fail-open; default 900)
 */

const SLOT_SUFFIX = '.slot';

export function slotDir(): string {
  return process.env.LT_E2E_SLOT_DIR || join(os.tmpdir(), 'lt-e2e-run-slots');
}

export function maxConcurrentE2eRuns(): number {
  const explicit = Number(process.env.LT_E2E_MAX_RUNS);
  if (Number.isInteger(explicit) && explicit >= 0) {
    return explicit;
  }
  const cores = os.availableParallelism?.() ?? os.cpus()?.length ?? 4;
  return cores >= 8 ? 2 : 1;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface SlotInfo {
  pid: number;
  startedAt: number;
}

/**
 * All currently held slots (live PIDs only). Slot files of dead processes are
 * removed as a side effect — this is the crash-recovery path.
 */
export function activeRuns(): SlotInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(slotDir());
  } catch {
    return [];
  }
  const active: SlotInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(SLOT_SUFFIX)) {
      continue;
    }
    const pid = Number(entry.slice(0, -SLOT_SUFFIX.length));
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const path = join(slotDir(), entry);
    if (!isPidAlive(pid)) {
      try {
        unlinkSync(path);
      } catch {
        /* another process removed it first */
      }
      continue;
    }
    let startedAt = 0;
    try {
      startedAt = JSON.parse(readFileSync(path, 'utf8')).startedAt ?? 0;
    } catch {
      try {
        startedAt = statSync(path).mtimeMs;
      } catch {
        /* keep 0 */
      }
    }
    active.push({ pid, startedAt });
  }
  return active;
}

/** Held slots excluding this process — the config uses this to detect parallel runs. */
export function countOtherActiveRuns(): number {
  return activeRuns().filter((s) => s.pid !== process.pid).length;
}

function ownSlotPath(): string {
  return join(slotDir(), `${process.pid}${SLOT_SUFFIX}`);
}

function releaseOwnSlot(): void {
  try {
    unlinkSync(ownSlotPath());
  } catch {
    /* already released or never claimed */
  }
}

function claimOwnSlot(): SlotInfo {
  const info: SlotInfo = { pid: process.pid, startedAt: Date.now() };
  mkdirSync(slotDir(), { recursive: true });
  writeFileSync(ownSlotPath(), JSON.stringify(info), { flag: 'w' });
  return info;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AcquireOptions {
  log?: (message: string) => void;
  /** Log cadence while waiting (default 15s — keeps the check.mjs watchdog fed). */
  logEveryMs?: number;
  maxRuns?: number;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Wait for a free e2e slot, then claim it. Returns a release function.
 *
 * Fail-open by design: after the timeout the slot is claimed anyway (with a warning) —
 * a broken governor must never be able to block a developer's test run outright.
 *
 * A process exiting normally releases via the returned function (wired to vitest's
 * globalSetup teardown); a killed process leaves its file behind, which the next
 * caller's PID-liveness check reclaims.
 */
export async function acquireRunSlot(options: AcquireOptions = {}): Promise<() => void> {
  const log = options.log ?? ((message: string) => console.info(message));
  const maxRuns = options.maxRuns ?? maxConcurrentE2eRuns();
  const pollMs = options.pollMs ?? 1000;
  const logEveryMs = options.logEveryMs ?? 15000;
  const timeoutMs = options.timeoutMs
    ?? (Number(process.env.LT_E2E_SLOT_TIMEOUT) > 0 ? Number(process.env.LT_E2E_SLOT_TIMEOUT) * 1000 : 900000);

  if (maxRuns === 0) {
    return () => {};
  }

  const startedWaiting = Date.now();
  let lastLog = 0;
  let waited = false;
  for (;;) {
    const others = activeRuns().filter((s) => s.pid !== process.pid);
    if (others.length < maxRuns) {
      const own = claimOwnSlot();
      // Two waiters can pass the check simultaneously and overshoot the limit.
      // The newest claimant backs off (tie-break by pid) — bounded, since one
      // of them always keeps its slot.
      const overshoot = activeRuns();
      if (overshoot.length > maxRuns) {
        const newest = [...overshoot].sort(
          (a, b) => b.startedAt - a.startedAt || b.pid - a.pid,
        )[0];
        if (newest.pid === own.pid) {
          releaseOwnSlot();
          await sleep(pollMs + Math.floor(Math.random() * pollMs));
          continue;
        }
      }
      if (waited) {
        log(`[e2e-governor] slot acquired after ${Math.round((Date.now() - startedWaiting) / 1000)}s`);
      }
      return releaseOwnSlot;
    }

    if (Date.now() - startedWaiting >= timeoutMs) {
      log(
        `[e2e-governor] no slot freed within ${Math.round(timeoutMs / 1000)}s — proceeding anyway (fail-open). `
          + `Active runs: ${others.map((s) => `pid ${s.pid}`).join(', ')}`,
      );
      claimOwnSlot();
      return releaseOwnSlot;
    }

    waited = true;
    if (Date.now() - lastLog >= logEveryMs) {
      lastLog = Date.now();
      log(
        `[e2e-governor] waiting for a free e2e slot — ${others.length}/${maxRuns} in use `
          + `(${others.map((s) => `pid ${s.pid}`).join(', ')}). `
          + 'Concurrent full-speed e2e runs starve each other; queuing is faster overall.',
      );
    }
    await sleep(pollMs);
  }
}
