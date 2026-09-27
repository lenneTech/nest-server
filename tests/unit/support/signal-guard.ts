/**
 * Signal guard for the unit tests: a test may send a real signal only to a process it spawned.
 *
 * Why this exists: on 2026-09-23 a test in the lt CLI called a kill helper with only the
 * platform injected. The signal path stayed real, and `process.kill(-1, 'SIGTERM')` is the
 * kill(2) broadcast — every process of the user. The Mac rebooted two minutes later.
 * `killTree` in scripts/check.mjs has the same shape: it takes a pid and signals it, so a
 * test that reaches the real signal path with a foreign pid does real damage.
 *
 * Ported from lt-monorepo `scripts/support/signal-guard.mjs` (f45cb2c, `node --test`).
 * `process.kill` with a real signal throws unless its target (or the group it names) is a
 * child this worker spawned. Probing with signal 0 stays allowed — it delivers nothing.
 *
 * This module has NO side effects: importing it installs nothing. `signal-guard.setup.ts`
 * (the vitest setup file) is what installs the guard, so a test that finds it installed has
 * proven the setup-file wiring rather than its own import. Vitest re-evaluates setup files
 * for every test file while `process` and `ChildProcess.prototype` live as long as the
 * worker, so the patch is installed once and its state hangs off `process`.
 *
 * Scope: signals sent from inside a test worker. A subprocess a test spawns runs without
 * this guard. `ChildProcess#kill` does not go through `process.kill` and is not guarded — its
 * target is the test's own child by construction.
 */
import { ChildProcess } from 'node:child_process';

interface GuardState {
  spawned: Set<number>;
  violations: string[];
}

const STATE = Symbol.for('lt.signal-guard.state');
const holder = process as unknown as Record<symbol, GuardState | undefined>;

/**
 * Why a signal must not be sent, or null when it may. Pure, so the guard's own test never has
 * to send anything real to prove the decision.
 */
export function signalVerdict(pid: unknown, signal: unknown, spawned: ReadonlySet<number>): null | string {
  if (signal === 0) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return `refused: pid ${String(pid)} is not an integer`;
  if (pid === 0 || pid === -1) return `refused: pid ${pid} addresses every process of a group or of the user`;
  if (!spawned.has(Math.abs(pid))) {
    return `refused: ${pid < 0 ? 'process group' : 'pid'} ${Math.abs(pid)} was not spawned by this test worker`;
  }
  return null;
}

/** Patch `process.kill` and `ChildProcess.prototype.spawn` for this worker; idempotent. */
export function installSignalGuard(): void {
  if (holder[STATE]) return;
  const state: GuardState = { spawned: new Set(), violations: [] };

  // Every async child_process API (spawn, exec, execFile, fork) ends in
  // ChildProcess.prototype.spawn, so recording here sees all of them. The sync variants
  // never hand out a live pid, so there is nothing of theirs to signal.
  const proto = ChildProcess.prototype as unknown as { spawn: (...args: unknown[]) => unknown };
  const originalSpawn = proto.spawn;
  proto.spawn = function (this: ChildProcess, ...args: unknown[]) {
    const result = originalSpawn.apply(this, args);
    if (typeof this.pid === 'number') state.spawned.add(this.pid);
    return result;
  };

  const realKill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: number | string) => {
    const verdict = signalVerdict(pid, signal ?? 'SIGTERM', state.spawned);
    if (verdict) {
      const message = `signal-guard: process.kill(${pid}, ${String(signal ?? 'SIGTERM')}) ${verdict}`;
      state.violations.push(message);
      throw new Error(message);
    }
    return realKill(pid, signal);
  }) as typeof process.kill;

  holder[STATE] = state;
}

/** Whether this worker runs under the guard. Reads only — never installs it. */
export function guardInstalled(): boolean {
  return holder[STATE] !== undefined;
}

/** Drain recorded refusals. Reads only — never installs the guard. */
export function takeViolations(): string[] {
  return holder[STATE]?.violations.splice(0) ?? [];
}
