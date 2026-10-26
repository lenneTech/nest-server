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
 * in vitest-e2e.config.mts cannot protect against this alone: the 1-minute average lags a
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
 * Age cap for a held slot — the PID-recycling fallback.
 *
 * Liveness alone is not enough: once a slot file's PID has been recycled and now belongs to an
 * unrelated long-lived process, that slot is immortal. It is counted as an active run forever and
 * nothing unlinks it. `startedAt` was already written; it was simply never read for this.
 *
 * One phantom on a >=8-core machine only pins low-resource mode on, which is cheap. Two of them,
 * or one on a <8-core machine where the cap is 1, make every later run wait out the full
 * fail-open timeout. `tests/db-lifecycle.reporter.ts` already guards exactly this case for the
 * run databases (`STALE_MAX_AGE_MS`, same reasoning).
 *
 * Six hours rather than that file's seven days: a slot is held for the length of ONE e2e run,
 * measured in minutes. Anything still holding one after six hours is not a run.
 */
const STALE_SLOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

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
    // Age cap — see STALE_SLOT_MAX_AGE_MS. A slot older than the cap is reclaimed even though its
    // PID answers, because that PID now belongs to something else. `startedAt === 0` means
    // neither the file nor its mtime could be read; that is not evidence of age, so such a slot
    // is left alone rather than reclaimed on a guess.
    if (startedAt > 0 && Date.now() - startedAt > STALE_SLOT_MAX_AGE_MS) {
      try {
        unlinkSync(path);
      } catch {
        /* another process removed it first */
      }
      continue;
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
  // The slot directory is shared by every lt project on the machine, and on a multi-user Linux
  // host `os.tmpdir()` is the world-writable `/tmp`. Writing with a bare `'w'` into a directory
  // created without a mode is then a symlink-following write: anybody can pre-create
  // `<pid>.slot` as a link, and the write truncates the target and puts this JSON into it with
  // the running user's privileges. 32768 links cover every possible pid.
  //
  // Three changes close it: an explicit 0700 on the directory, removing any existing entry
  // (which unlinks a SYMLINK rather than following it), and `flag: 'wx'`, which fails instead of
  // following whatever reappears in between. `wx` cannot spuriously fail — the unlink above just
  // removed our own path, and the name contains our own pid.
  //
  // On macOS and in a CI container none of this is reachable (`/var/folders/…/T` is 0700
  // per-user, a job's `/tmp` is private). On Windows the modes are ignored; unlink + `wx` still
  // apply. A directory that already exists keeps its mode — `mkdirSync` does not touch it.
  mkdirSync(slotDir(), { mode: 0o700, recursive: true });
  try {
    unlinkSync(ownSlotPath());
  } catch {
    /* nothing there, which is the normal case */
  }
  writeFileSync(ownSlotPath(), JSON.stringify(info), { flag: 'wx', mode: 0o600 });
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
      let own: SlotInfo;
      try {
        own = claimOwnSlot();
      } catch (error) {
        // Fail-open is this module's stated contract, and an unwritable slot directory is exactly
        // where it used to break: another user owns the directory 0755 on a shared host, or the
        // tmpdir is read-only, and the throw escapes through `global-setup.ts` — which does not
        // wrap this call — taking the whole suite with it. The governor is a throughput measure,
        // not a correctness one, so running ungoverned is the lesser failure.
        log(
          `[e2e-governor] could not claim a slot (${error instanceof Error ? error.message : 'unknown error'}) — `
            + 'proceeding without the governor.',
        );
        return () => {};
      }
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
      try {
        claimOwnSlot();
      } catch {
        // Same reasoning as above: this path is already the fail-open one, so a failing claim
        // here must not turn it back into a hard failure.
        return () => {};
      }
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
