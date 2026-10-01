#!/usr/bin/env node
/**
 * Verify the built server boots and renders one page, then shut it down.
 *
 * Replaces `check-server-start.sh`. The bash version needed `mktemp`, `trap`,
 * `disown`, `kill -0` and `sed`, and was reached via `bash …` — which cmd.exe
 * either cannot find or resolves to `C:\Windows\System32\bash.exe`, the WSL
 * launcher. This one uses only Node built-ins and spawns the server via
 * `process.execPath` without a shell, so it runs the same on Windows, macOS
 * and Linux.
 *
 * Behaviour (the contract other repos adopt; defaults are the Nuxt ones):
 *   1. Allocates a free port by binding `:0` on 127.0.0.1 and releasing it.
 *   2. Spawns `node <entry>` with `<portEnv>=<port>` (no shell).
 *   3. "Up" = a line of server output matches one of `readyPatterns`.
 *   4. Then GETs `smokePath` (30 s timeout, redirects not followed). Only a
 *      2xx or 3xx counts: a bundle can listen and still throw on every render.
 *   5. Always stops the server: SIGTERM, up to 2 s grace, then SIGKILL on POSIX;
 *      `taskkill /PID <pid> /T /F` on Windows (no signals there).
 *
 * Deviation from the nuxt-base-starter original (8ac2766), and the only one: the
 * second, closed port exported as `NUXT_API_URL` / `NUXT_PUBLIC_API_URL` is gone.
 * It keeps a Nuxt SSR fetch from hanging; a Nest server reads neither variable
 * (checked: `src/` names no `NUXT_*` variable except `NUXT_PUBLIC_COOKIE_PREFIX`, in
 * a log text and a comment), so here it would only suggest a dependency that does
 * not exist. The defaults stay the Nuxt ones so the file diffs cleanly against
 * the original; this repo passes every option on the command line (`check:server-start`).
 * Same logic as nest-server-starter's copy; only this paragraph and oxfmt's line wrapping differ.
 *
 * Exit code: 0 when the server came up and rendered, 1 otherwise — boot
 * timeout (`bootTimeoutMs`, default 60 s), early exit of the server, a non-2xx/3xx
 * response or no response at all. The last 30 lines of server output are printed
 * on failure.
 */
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Defaults for a Nuxt build. Other servers override these via `run(options)`. */
export const NUXT_DEFAULTS = Object.freeze({
  bootTimeoutMs: 60_000,
  entry: '.output/server/index.mjs',
  // NITRO_PORT, not PORT: Nitro reads PORT as a string without parseInt and feeds
  // it straight into net.Server#listen.
  portEnv: 'NITRO_PORT',
  readyPatterns: [/Listening on/, /Nitro ready/, /Local:/],
  smokePath: '/',
});

/** Pure: whether an HTTP status counts as "rendered". `0` means no response. */
export function isRenderedStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 400;
}

/** Pure: whether a chunk of server output signals that it is listening. */
export function isReadyOutput(text, patterns) {
  return patterns.some((re) => re.test(text));
}

/**
 * Pure: whether a number may become a kill target at all — an integer above 1 on POSIX
 * (1 is init, 0 and -1 address a group or every process of the user) and above 4 on
 * Windows (0 is System Idle, 4 is System). A failed spawn leaves `child.pid` undefined.
 */
export function isKillablePid(pid, platform = process.platform) {
  return Number.isInteger(pid) && pid > (platform === 'win32' ? 4 : 1);
}

/**
 * Pure: how to stop the server's process tree on this platform, or null when `pid` must not
 * be touched. Same contract as `killTreePlan` in lt-monorepo's check.mjs, kept local so this
 * file has no sibling imports and can be copied on its own.
 */
export function killTreePlan(pid, signal, platform = process.platform) {
  if (!isKillablePid(pid, platform)) return null;
  return platform === 'win32' ? { args: ['/PID', String(pid), '/T', '/F'], command: 'taskkill' } : { signal };
}

/** Bind `:0` on loopback, read the port, release it. */
function allocPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** GET `url`; resolves to the status, or 0 when no response arrived. */
async function smokeRequest(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    return res.status;
  } catch {
    return 0;
  }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stop the child's tree. Only ever called with the pid of the child we spawned. */
async function stop(child) {
  const pid = child.pid;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const plan = killTreePlan(pid, 'SIGTERM');
  if (!plan) return;
  if (plan.command) {
    try {
      execFileSync(plan.command, plan.args, { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    return;
  }
  child.kill(plan.signal);
  // Nitro can take a moment to unwind its listeners; give it up to 2 s.
  for (let i = 0; i < 4 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 500));
  if (isAlive(pid)) child.kill('SIGKILL');
}

/**
 * Boot, smoke-test, stop. Resolves to the exit code (0 ok, 1 failed); never rejects.
 * `log` receives the human-readable report lines.
 */
export async function run(options = {}, log = console.log) {
  const opts = { ...NUXT_DEFAULTS, ...options };
  const cwd = opts.cwd ?? process.cwd();
  const lines = [];
  const tail = (n) => lines.slice(-n).join('\n');

  let port;
  try {
    port = await allocPort();
  } catch (err) {
    log(String(err?.message || err));
    return 1;
  }
  log(`Using free port: ${port}`);

  const env = { ...process.env, [opts.portEnv]: String(port) };
  const child = spawn(process.execPath, [resolve(cwd, opts.entry)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

  // Settles once with the first of: ready, exit, spawn error, timeout.
  const outcome = await new Promise((settle) => {
    const timer = setTimeout(() => settle({ kind: 'timeout' }), opts.bootTimeoutMs);
    const done = (result) => {
      clearTimeout(timer);
      settle(result);
    };
    let pending = '';
    const onData = (chunk) => {
      pending += chunk.toString();
      const parts = pending.split(/\r?\n/);
      pending = parts.pop();
      lines.push(...parts);
      if (isReadyOutput(parts.join('\n') + '\n' + pending, opts.readyPatterns)) done({ kind: 'ready' });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code, signal) => {
      if (pending) lines.push(pending);
      done({ code, kind: 'exited', signal });
    });
    child.once('error', (err) => done({ error: err, kind: 'error' }));
  });

  try {
    if (outcome.kind === 'ready') {
      const status = await smokeRequest(`http://127.0.0.1:${port}${opts.smokePath}`);
      if (!isRenderedStatus(status)) {
        log(
          `Server booted but GET ${opts.smokePath} did not render (HTTP ${status || '<no response>'}). Last 30 log lines:`,
        );
        log(tail(30));
        return 1;
      }
      log(tail(5));
      log(`Server started and rendered GET ${opts.smokePath} with HTTP ${status} - check complete`);
      return 0;
    }
    if (outcome.kind === 'exited') {
      log(
        `Server process exited unexpectedly (code ${outcome.code ?? '-'}, signal ${outcome.signal ?? '-'}). Full log:`,
      );
      log(lines.join('\n'));
      return 1;
    }
    if (outcome.kind === 'error') {
      log(`Server process could not be started: ${outcome.error?.message || outcome.error}`);
      return 1;
    }
    log(`Server failed to start within ${Math.round(opts.bootTimeoutMs / 1000)} seconds. Last 30 log lines:`);
    log(tail(30));
    return 1;
  } finally {
    await stop(child);
  }
}

/**
 * Parse `--entry=…`, `--port-env=…`, `--path=…`, `--timeout=<seconds>` and
 * `--ready=<regex>` (repeatable; replaces the default ready patterns).
 */
export function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    const [key, value] = arg.split(/=(.*)/s, 2);
    if (key === '--entry') options.entry = value;
    else if (key === '--port-env') options.portEnv = value;
    else if (key === '--path') options.smokePath = value;
    else if (key === '--timeout') options.bootTimeoutMs = Number(value) * 1000;
    else if (key === '--ready') (options.readyPatterns ??= []).push(new RegExp(value));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// Run only when invoked as the CLI, so tests can import the pure helpers.
function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch (err) {
    // Fail closed: "cannot tell" must never become a green check that never ran.
    process.stderr.write(
      `[check-server-start] cannot resolve the CLI entry (${err?.code || err}) — refusing to report success\n`,
    );
    process.exit(1);
  }
}

if (isCliEntry()) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  process.exitCode = await run(options);
}
