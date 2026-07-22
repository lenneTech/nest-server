import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Proves the signal path against a REAL process, which the unit spec structurally cannot.
 *
 * `process-diagnostics.helper.spec.ts` injects an `EventEmitter`, so it can only assert the
 * DECISION (log, remove listener, call `reraise`). An EventEmitter has no OS signal disposition,
 * so it can never show that the process actually terminates — and a handler that logs a signal
 * but leaves the process running is the exact failure this whole helper exists to prevent.
 *
 * `scripts/check-server-start.sh` does not close the gap either: its cleanup sends SIGTERM and
 * escalates to SIGKILL after ~2 s WITHOUT failing, so a hung SIGTERM passes that gate silently.
 *
 * Costs one `tsx` child (~1 s), needs no MongoDB, and stays in the unit runner.
 */

const FIXTURE = join(process.cwd(), 'tests/unit/fixtures/process-diagnostics-signal-child.ts');

let child: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
});

/**
 * Spawns the fixture and resolves once it reports readiness.
 *
 * @returns The running child plus a live stderr buffer
 */
async function startChild(): Promise<{ proc: ChildProcessWithoutNullStreams; stderr: () => string }> {
  // `node --import tsx <file>` runs the fixture IN THIS ONE PROCESS. Spawning `npx tsx` instead
  // would make npx the direct child, so `kill('SIGTERM')` would hit npx — and the observed exit
  // would be a plain code with `signal === null`, silently proving nothing about the helper.
  const proc = spawn(process.execPath, ['--import', 'tsx', FIXTURE], { cwd: process.cwd(), env: { ...process.env } });
  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((settle, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture never reported READY. stderr:\n${stderr}`)), 30_000);
    proc.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timer);
        settle();
      }
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited before READY (code=${code}, signal=${signal}). stderr:\n${stderr}`));
    });
  });

  return { proc, stderr: () => stderr };
}

describe('process diagnostics against a real process', () => {
  it(
    'labels SIGTERM and actually terminates',
    async () => {
      const { proc, stderr } = await startChild();
      child = proc;

      const exited = new Promise<{ code: null | number; signal: NodeJS.Signals | null }>((settle) => {
        proc.on('exit', (code, signal) => settle({ code, signal }));
      });

      proc.kill('SIGTERM');
      const { signal } = await exited;

      // Terminated BY the signal — i.e. the re-raise restored the default disposition. A handler
      // that swallowed the signal would hang here until the test timeout.
      expect(signal).toBe('SIGTERM');
      expect(stderr()).toContain('[signal] received SIGTERM');
      expect(stderr()).toContain('external termination');
    },
    45_000,
  );

  it(
    'labels SIGINT and actually terminates',
    async () => {
      const { proc, stderr } = await startChild();
      child = proc;

      const exited = new Promise<{ code: null | number; signal: NodeJS.Signals | null }>((settle) => {
        proc.on('exit', (code, signal) => settle({ code, signal }));
      });

      proc.kill('SIGINT');
      const { signal } = await exited;

      expect(signal).toBe('SIGINT');
      expect(stderr()).toContain('[signal] received SIGINT');
    },
    45_000,
  );
});
