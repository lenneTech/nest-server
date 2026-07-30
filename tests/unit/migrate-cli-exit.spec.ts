import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Proves the CLI's exit path against a REAL process, which an in-process test cannot.
 *
 * Two guarantees are load-bearing and neither is observable without a child:
 *
 * 1. **It terminates even when a handle leaks.** Migrations hold MongoDB, GridFS
 *    and state-store connections; one left open keeps the event loop alive and
 *    `migrate up` never returns. `docker-entrypoint.sh` runs migrations before it
 *    `exec`s the server, so the container never reaches the server at all — and
 *    with no timeout anywhere, it hangs rather than fails.
 * 2. **It does not truncate its own output.** `process.exit()` does NOT drain
 *    stdout, and stdout is asynchronous whenever it is a pipe — Docker's log
 *    driver and every CI log collector are pipes. Past the ~64 KiB pipe buffer a
 *    naive exit discards the rest, and the line at risk is the LAST one, which is
 *    exactly the completion marker a CI step greps for.
 *
 * Costs one `tsx` child (~2 s), needs no MongoDB, and stays in the unit runner.
 */

const FIXTURE = join(process.cwd(), 'tests/unit/fixtures/migrate-cli-exit-child.ts');

/**
 * Runs the fixture and collects everything it wrote.
 *
 * The fixture emits ~1 MB, far past the 64 KiB kernel pipe buffer. Deliberately
 * NO artificial pause on the read side: pausing lets the child finish and close
 * the pipe while the stream is still parked, so the unread bytes vanish for a
 * reason that has nothing to do with the code under test — an earlier version of
 * this spec failed exactly that way.
 *
 * Scope of what this proves, measured by mutation rather than assumed:
 * - Removing the exit entirely → this test FAILS on the 30 s timeout. The
 *   termination guarantee is genuinely pinned here.
 * - Replacing `flushAndExit` with a bare `process.exit(0)` → this test still
 *   passes, because a fast local reader keeps the buffer drained. The same
 *   mutation DOES truncate (377 KB of 1.06 MB) when run outside the vitest
 *   worker, so the completeness assertion below is a real invariant, just not one
 *   this environment can be relied on to break. Do not read a green run here as
 *   proof that the drain is present.
 */
async function runFixture(lines: number): Promise<{ code: null | number; stderr: string; stdout: string }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
    cwd: process.cwd(),
    env: { ...process.env, FIXTURE_LINES: String(lines) },
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // Wait for 'close', NOT 'exit'. 'exit' fires when the process ends, which can
  // be BEFORE the buffered stdout has been read — the assertions would then run
  // against a half-collected string and fail for a reason that has nothing to do
  // with the drain under test. 'close' fires once every stdio stream is done.
  const code = await new Promise<null | number>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`CLI did not exit within 30s — the leaked handle kept it alive. stderr:\n${stderr}`));
    }, 30_000);
    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    proc.on('error', reject);
  });

  return { code, stderr, stdout };
}

describe('migrate CLI exit path', () => {
  it('exits despite a leaked handle, without losing buffered output', async () => {
    const lines = 20000;
    const { code, stderr, stdout } = await runFixture(lines);

    expect(code, `child failed. stderr:\n${stderr}`).toBe(0);
    // The sentinel is written last, so its presence proves nothing before it was cut.
    expect(stdout, `stderr:\n${stderr}`).toContain('SENTINEL-LAST-LINE');
    expect(stdout.match(/^line-\d+-padding/gm)).toHaveLength(lines);
  }, 40_000);
});
