/**
 * Guards `scripts/check-server-start.mjs`, the last step of every `check` chain
 * (`pnpm run check:server-start`).
 *
 * Adopted from nuxt-base-starter (8ac2766) together with the script, via nest-server-starter.
 * The pure helpers are checked directly. The runner is checked end to end as the CLI the chain calls, against small
 * fixture servers in `tests/fixtures/server-start/`, OUT OF PROCESS: the exit code of the real
 * process is what the `check` chain acts on. After each run the server's port must be closed
 * again, i.e. the server really was stopped. Signals only ever reach the fixture child the
 * runner itself spawned; the Windows kill path is covered by the plan test only.
 *
 * THE NEST-SPECIFIC CASES
 * The ready pattern lives in package.json, the line it has to match lives in src/main.ts. The two
 * drifted apart once already: main.ts fixed its "Server startet at" typo, check-envs.sh kept
 * matching only the typo and timed out on every platform until it was removed. So the pattern is checked
 * against the real source line here, where a mismatch fails in milliseconds, instead of surfacing
 * as a 60-second boot timeout in CI that looks like a slow machine.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isKillablePid,
  isReadyOutput,
  isRenderedStatus,
  killTreePlan,
  NUXT_DEFAULTS,
  parseArgs,
} from '../../scripts/check-server-start.mjs';

// `process.cwd()` rather than `import.meta`: tsconfig.json compiles to commonjs (see pnpm-pin.spec.ts).
const ROOT = process.cwd();
const fixtures = join(ROOT, 'tests', 'fixtures', 'server-start');
const runner = join(ROOT, 'scripts', 'check-server-start.mjs');
const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).scripts;

/** The runner's arguments as the `check:server-start` script passes them. */
function serverStartArgs(): string[] {
  const command = scripts['check:server-start'] ?? '';
  const tail = command.slice(command.indexOf('check-server-start.mjs') + 'check-server-start.mjs'.length);
  // Split on spaces outside double quotes, then drop the quotes the shell would remove.
  return (tail.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((arg: string) => arg.replace(/"/g, ''));
}

/** Run the CLI against a fixture; resolves to its exit code, output, port and duration. */
function runFixture(
  entry: string,
  timeoutSeconds = 10,
  extraArgs: string[] = [],
): Promise<{ code: null | number; ms: number; output: string; port: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [runner, `--entry=${entry}`, `--timeout=${timeoutSeconds}`, ...extraArgs], {
      cwd: fixtures,
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.once('close', (code) =>
      resolve({ code, ms: Date.now() - started, output, port: Number(/Using free port: (\d+)/.exec(output)?.[1]) }),
    );
  });
}

/** Resolves true when something accepts a connection on the port. */
function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('check-server-start helpers', () => {
  it.each([200, 204, 301, 302, 399])('counts HTTP %i as rendered', (status) => {
    expect(isRenderedStatus(status)).toBe(true);
  });

  it.each([0, 199, 400, 404, 500, Number.NaN])('does not count HTTP %s as rendered', (status) => {
    expect(isRenderedStatus(status)).toBe(false);
  });

  it('recognises the Nitro ready lines', () => {
    expect(isReadyOutput('Listening on http://[::]:3000', NUXT_DEFAULTS.readyPatterns)).toBe(true);
    expect(isReadyOutput('building…', NUXT_DEFAULTS.readyPatterns)).toBe(false);
  });

  it('plans taskkill on Windows and a signal elsewhere', () => {
    expect(killTreePlan(4242, 'SIGTERM', 'win32')).toEqual({ args: ['/PID', '4242', '/T', '/F'], command: 'taskkill' });
    expect(killTreePlan(4242, 'SIGTERM', 'linux')).toEqual({ signal: 'SIGTERM' });
  });

  it('plans nothing for a pid that is not ours — a failed spawn, init, a broadcast, Windows System', () => {
    for (const pid of [undefined, Number.NaN, -1, 0, 1]) {
      expect(killTreePlan(pid, 'SIGTERM', 'linux'), `pid ${String(pid)}`).toBeNull();
    }
    for (const pid of [undefined, 0, 4]) {
      expect(killTreePlan(pid, 'SIGTERM', 'win32'), `pid ${String(pid)}`).toBeNull();
    }
    expect(isKillablePid(2, 'linux')).toBe(true);
    expect(isKillablePid(5, 'win32')).toBe(true);
  });

  it('rejects an unknown argument', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

describe('check:server-start as configured for this repo', () => {
  const options = parseArgs(serverStartArgs());

  it('starts the built API on NSC__PORT and smoke-tests /', () => {
    expect(options).toEqual({
      entry: 'dist/main.js',
      portEnv: 'NSC__PORT',
      readyPatterns: [expect.any(RegExp)],
      smokePath: '/',
    });
  });

  it('matches the line src/main.ts actually prints once the server listens', () => {
    const source = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf-8');
    const logged = /`(Server start\w* at) \$\{/.exec(source)?.[1];
    expect(logged, 'main.ts no longer prints "Server start… at ${url}" — update --ready').toBeDefined();
    expect(isReadyOutput(`${logged} http://[::1]:3000`, options.readyPatterns ?? [])).toBe(true);
  });

  it('still matches the historical "startet" spelling of projects generated before 11.32', () => {
    expect(isReadyOutput('Server startet at http://[::1]:3000', options.readyPatterns ?? [])).toBe(true);
  });

  it('does not take Nest’s own startup line for "listening"', () => {
    // Nest logs it at the end of init(), BEFORE httpAdapter.listen() (@nestjs/core
    // nest-application.js, init() vs listen()), so the smoke request could still hit a closed port.
    expect(isReadyOutput('Nest application successfully started', options.readyPatterns ?? [])).toBe(false);
  });
});

describe('check-server-start CLI', () => {
  it('returns 0 when the server boots and renders, and stops it afterwards', async () => {
    const { code, output, port } = await runFixture('ok.mjs');

    expect(code, output).toBe(0);
    expect(await portAcceptsConnections(port)).toBe(false);
  });

  it('returns 0 for a Nest-style server started with this repo’s own arguments', async () => {
    const own = serverStartArgs().filter((arg) => !arg.startsWith('--entry='));
    const { code, output, port } = await runFixture('nest.mjs', 10, own);

    expect(code, output).toBe(0);
    expect(output).toMatch(/rendered GET \/ with HTTP 200/);
    expect(await portAcceptsConnections(port)).toBe(false);
  });

  it('fails fast, not after the boot timeout, when the ready pattern does not match', async () => {
    const { code, ms, output, port } = await runFixture('nest.mjs', 1, [
      '--port-env=NSC__PORT',
      '--ready=Server startet? at nowhere',
    ]);

    expect(code, output).toBe(1);
    expect(output).toMatch(/failed to start within 1 seconds/);
    expect(ms).toBeLessThan(10_000);
    expect(await portAcceptsConnections(port)).toBe(false);
  });

  it('returns 1 when the server listens but the render fails', async () => {
    const { code, output, port } = await runFixture('broken-render.mjs');

    expect(code).toBe(1);
    expect(output).toMatch(/did not render \(HTTP 500\)/);
    expect(await portAcceptsConnections(port)).toBe(false);
  });

  it('returns 1 when the server dies during boot', async () => {
    const { code, output } = await runFixture('crash.mjs');

    expect(code).toBe(1);
    expect(output).toMatch(/exited unexpectedly \(code 3/);
    expect(output).toMatch(/boom during boot/);
  });

  it('returns 1 when the server never reports ready', async () => {
    const { code, output } = await runFixture('silent.mjs', 1);

    expect(code).toBe(1);
    expect(output).toMatch(/failed to start within 1 seconds/);
  });

  it('returns 1 when the entry does not exist', async () => {
    const { code } = await runFixture('does-not-exist.mjs');

    expect(code).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('escalates to SIGKILL for a server that ignores SIGTERM', async () => {
    const { code, output, port } = await runFixture('ignores-sigterm.mjs');

    expect(code, output).toBe(0);
    expect(await portAcceptsConnections(port)).toBe(false);
  });
});
