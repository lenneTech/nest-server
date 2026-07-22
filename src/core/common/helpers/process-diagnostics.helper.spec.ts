import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleFatalBootstrapError, installProcessDiagnostics } from './process-diagnostics.helper';

// `vi.spyOn(fs, 'writeSync')` cannot work here — an ESM module namespace is not configurable, so
// the property cannot be redefined. Mocking the module is the only way to observe the default
// sink, and the helper imports nothing else from `node:fs`.
const { writeSyncMock } = vi.hoisted(() => ({ writeSyncMock: vi.fn<(fd: number, data: string) => number>() }));
vi.mock('node:fs', () => ({ writeSync: writeSyncMock }));

/**
 * Regression guard for the "silent exit" class of failures: a Node API under a ts-node dev
 * runner can die printing nothing but `app crashed` — no stacktrace, which reads like a
 * product bug and costs long, misdirected debugging sessions. The diagnostics helper makes
 * the exit reason visible — a rejected fire-and-forget promise no longer takes the server
 * down, an uncaught exception is logged with a clear marker before it exits, and an EXTERNAL
 * termination signal (another tool's pkill, `lt dev down`, an OS OOM SIGTERM, Ctrl-C) is
 * logged as such instead of masquerading as an in-process crash.
 *
 * The installer is tested against an injected EventEmitter so the real process (and the
 * Vitest runner it lives in) is never signalled or exited.
 *
 * Repo-wiring assertions (src/main.ts, src/index.ts, nodemon.json) deliberately live in
 * `tests/unit/process-diagnostics-wiring.spec.ts`, NOT here: this file ships inside `src/core/`
 * and is copied verbatim into vendor-mode consumer projects, where those repo-root paths do not
 * exist. Keeping this spec free of `process.cwd()` is what makes it portable.
 */
function setup(
  preRegister?: Partial<Record<string, () => void>>,
  options?: Parameters<typeof installProcessDiagnostics>[0],
) {
  const target = new EventEmitter();
  target.setMaxListeners(50);
  const errors: string[] = [];
  const warnings: string[] = [];
  const logger = {
    error: (message: string) => errors.push(message),
    warn: (message: string) => warnings.push(message),
  };
  const exit = vi.fn();
  const reraise = vi.fn();
  if (preRegister) {
    for (const [event, fn] of Object.entries(preRegister)) {
      target.on(event, fn);
    }
  }
  installProcessDiagnostics({ exit, logger, reraise, target, ...options });
  return { errors, exit, reraise, target, warnings };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('installProcessDiagnostics', () => {
  it('logs an unhandled rejection but keeps the process alive', () => {
    const { exit, target, warnings } = setup();
    target.emit('unhandledRejection', new Error('SMTP down'));
    expect(warnings.some((line) => line.includes('[unhandledRejection]') && line.includes('SMTP down'))).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it('routes an unhandled rejection to the NON-blocking sink', () => {
    // An unhandled rejection can fire once per request while the server keeps serving. A
    // synchronous write would block the whole event loop until stderr drains, so this path must
    // use `warn` (async) and never `error` (sync). Nothing is terminating, so there is no
    // last-gasp guarantee worth blocking for.
    const { errors, target, warnings } = setup();
    target.emit('unhandledRejection', new Error('per-request failure'));
    expect(warnings).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it('formats a non-Error rejection reason via String()', () => {
    const { target, warnings } = setup();
    target.emit('unhandledRejection', 'plain string reason');
    expect(warnings.some((line) => line.includes('[unhandledRejection]') && line.includes('plain string reason'))).toBe(
      true,
    );
  });

  it('exits on an unhandled rejection when onUnhandledRejection is "exit"', () => {
    // Restores Node >= 15's own `--unhandled-rejections=throw` default for deployments that
    // prefer a clean restart over serving from an unknown state.
    const { errors, exit, target } = setup(undefined, { onUnhandledRejection: 'exit' });
    target.emit('unhandledRejection', new Error('inconsistent state'));
    expect(errors.some((line) => line.includes('[unhandledRejection]'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs an uncaught exception with a marker and exits with code 1', () => {
    const { errors, exit, target } = setup();
    target.emit('uncaughtException', new Error('boom'));
    expect(errors.some((line) => line.includes('[uncaughtException]') && line.includes('boom'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does NOT print the error message twice', () => {
    // `error.stack` already begins with `${name}: ${message}`. Prefixing the message again put the
    // same line in the output twice, which reads like two distinct failures.
    const { errors, target } = setup();
    const error = new Error('duplicated');
    target.emit('uncaughtException', error);
    const occurrences = errors[0].split('duplicated').length - 1;
    expect(occurrences).toBe(1);
  });

  it('falls back to name + message when an Error carries no stack', () => {
    const { errors, target } = setup();
    const error = new Error('no stack here');
    error.stack = undefined;
    target.emit('uncaughtException', error);
    expect(errors[0]).toContain('Error: no stack here');
  });

  it('does NOT register a process warning handler', () => {
    // Node prints process warnings to stderr itself and adding a listener does not replace that —
    // it appends a second, strictly worse copy (Node's own line carries the warning `name` and the
    // `--trace-warnings` hint). Duplicating it doubles the volume on a path that fires during
    // normal operation.
    const { target } = setup();
    expect(target.listenerCount('warning')).toBe(0);
  });

  it('logs a non-zero exit code', () => {
    const { errors, target } = setup();
    target.emit('exit', 143);
    expect(errors.some((line) => line.includes('[exit]') && line.includes('143'))).toBe(true);
  });

  it('stays silent on a clean exit', () => {
    // A clean exit is not a diagnostic. Logging it under every CLI script and every graceful
    // shutdown trains readers to ignore the marker.
    const { errors, target } = setup();
    target.emit('exit', 0);
    expect(errors).toHaveLength(0);
  });

  it('logs SIGTERM as external termination and re-raises it when it is the only listener', () => {
    const { errors, exit, reraise, target } = setup();
    target.emit('SIGTERM', 'SIGTERM');
    expect(errors.some((line) => line.includes('[signal]') && line.includes('SIGTERM'))).toBe(true);
    expect(reraise).toHaveBeenCalledWith('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    // The handler MUST remove itself before re-raising — otherwise the re-raised signal
    // re-enters the same handler forever (infinite log-and-re-raise loop, never terminates).
    expect(target.listenerCount('SIGTERM')).toBe(0);
  });

  it('logs SIGINT and re-raises it when it is the only listener', () => {
    const { errors, reraise, target } = setup();
    target.emit('SIGINT', 'SIGINT');
    expect(errors.some((line) => line.includes('[signal]') && line.includes('SIGINT'))).toBe(true);
    expect(reraise).toHaveBeenCalledWith('SIGINT');
    expect(target.listenerCount('SIGINT')).toBe(0);
  });

  it.each(['SIGHUP', 'SIGQUIT'] as const)('labels %s as an external termination too', (signal) => {
    // A closed terminal (SIGHUP) or a SIGQUIT from an orchestrator used to terminate unannotated,
    // producing exactly the stackless death this helper exists to explain.
    const { errors, reraise, target } = setup();
    target.emit(signal, signal);
    expect(errors.some((line) => line.includes('[signal]') && line.includes(signal))).toBe(true);
    expect(reraise).toHaveBeenCalledWith(signal);
  });

  it('does NOT touch SIGUSR2', () => {
    // nodemon restarts the app with SIGUSR2. Attaching a listener overrides its disposition, and
    // labelling a restart is not worth changing how restarts behave.
    const { target } = setup();
    expect(target.listenerCount('SIGUSR2')).toBe(0);
  });

  it('does NOT re-raise a signal when a graceful-shutdown handler is also registered', () => {
    // `app.enableShutdownHooks()` registers its own SIGTERM/SIGINT listener. Re-raising on top of
    // it would kill the process mid-shutdown and defeat the graceful teardown.
    const other = vi.fn();
    const { errors, reraise, target } = setup({ SIGTERM: other }, { shutdownTimeoutMs: 0 });
    target.emit('SIGTERM', 'SIGTERM');
    expect(errors.some((line) => line.includes('[signal]'))).toBe(true);
    expect(errors.some((line) => line.includes('another handler owns the shutdown'))).toBe(true);
    expect(reraise).not.toHaveBeenCalled();
  });

  it('forces an exit when the co-listener never finishes the shutdown', () => {
    // Abdicating unconditionally means a co-listener that never terminates makes SIGTERM a
    // permanent no-op while the log line claims the process is going down — only SIGKILL would
    // still work. The watchdog bounds that.
    vi.useFakeTimers();
    const { errors, exit, target } = setup({ SIGTERM: vi.fn() }, { shutdownTimeoutMs: 30_000 });
    target.emit('SIGTERM', 'SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(errors.some((line) => line.includes('shutdown watchdog expired'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does not arm the watchdog when shutdownTimeoutMs is 0', () => {
    vi.useFakeTimers();
    const { exit, target } = setup({ SIGTERM: vi.fn() }, { shutdownTimeoutMs: 0 });
    target.emit('SIGTERM', 'SIGTERM');
    vi.advanceTimersByTime(120_000);
    expect(exit).not.toHaveBeenCalled();
  });

  it('is idempotent — installing twice does not stack duplicate handlers', () => {
    const target = new EventEmitter();
    const logger = { error: () => undefined };
    const exit = vi.fn();
    const reraise = vi.fn();
    installProcessDiagnostics({ exit, logger, reraise, target });
    installProcessDiagnostics({ exit, logger, reraise, target });
    expect(target.listenerCount('uncaughtException')).toBe(1);
    expect(target.listenerCount('unhandledRejection')).toBe(1);
    expect(target.listenerCount('SIGTERM')).toBe(1);
    expect(target.listenerCount('SIGINT')).toBe(1);
  });

  it('falls back to the error sink when a custom logger provides no warn', () => {
    const target = new EventEmitter();
    const errors: string[] = [];
    installProcessDiagnostics({
      exit: vi.fn(),
      logger: { error: (message: string) => errors.push(message) },
      reraise: vi.fn(),
      target,
    });
    target.emit('unhandledRejection', new Error('no warn sink'));
    expect(errors.some((line) => line.includes('[unhandledRejection]'))).toBe(true);
  });
});

describe('redaction and truncation', () => {
  it('masks a JWT and truncates an oversized line', () => {
    const target = new EventEmitter();
    const warnings: string[] = [];
    installProcessDiagnostics({
      exit: vi.fn(),
      logger: { error: () => undefined, warn: (message: string) => warnings.push(message) },
      reraise: vi.fn(),
      target,
    });
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(40)}.${'b'.repeat(20)}`;
    const error = new Error(`token=${jwt} ${'x'.repeat(30_000)}`);
    error.stack = `Error: token=${jwt} ${'x'.repeat(30_000)}`;
    target.emit('unhandledRejection', error);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(jwt);
    expect(warnings[0]).toContain('[truncated]');
    expect(warnings[0].length).toBeLessThan(20_000);
  });
});

describe('defaultDiagnosticsLogger', () => {
  it('writes synchronously to fd 2 so a last-gasp line cannot be truncated', () => {
    // console.error is asynchronous on a pipe, so a line written immediately before process.exit()
    // can be dropped — silently losing the very line this helper exists to emit.
    writeSyncMock.mockReset();
    writeSyncMock.mockReturnValue(0);
    const target = new EventEmitter();
    installProcessDiagnostics({ exit: vi.fn(), reraise: vi.fn(), target });
    target.emit('uncaughtException', new Error('sync sink'));

    expect(writeSyncMock).toHaveBeenCalled();
    const [fd, payload] = writeSyncMock.mock.calls[0];
    expect(fd).toBe(2);
    expect(String(payload)).toContain('[uncaughtException]');
  });

  it('survives a broken stderr instead of escalating', () => {
    // EBADF (fd 2 closed), EPIPE (reader exited) and EAGAIN (non-blocking pipe) all make writeSync
    // throw. A throw raised INSIDE the uncaughtException handler makes Node exit 7 and print its
    // own "throw inside handler" message — losing the original error entirely.
    writeSyncMock.mockReset();
    writeSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('EBADF: bad file descriptor'), { code: 'EBADF' });
    });
    const exit = vi.fn();
    const target = new EventEmitter();
    installProcessDiagnostics({ exit, reraise: vi.fn(), target });

    expect(() => target.emit('uncaughtException', new Error('original failure'))).not.toThrow();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('handleFatalBootstrapError', () => {
  it('logs a failed bootstrap with a marker and exits with code 1', () => {
    const errors: string[] = [];
    const logger = { error: (message: string) => errors.push(message) };
    const exit = vi.fn();
    handleFatalBootstrapError(new Error('listen EADDRINUSE: address already in use'), { exit, logger });
    expect(errors.some((line) => line.includes('[bootstrap]') && line.includes('EADDRINUSE'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('redacts secrets out of a startup error before logging it', () => {
    // The documented motivating failures ("DB unreachable") carry connection strings.
    const errors: string[] = [];
    const exit = vi.fn();
    handleFatalBootstrapError(new Error('connect failed: password=hunter2'), {
      exit,
      logger: { error: (message: string) => errors.push(message) },
    });
    expect(errors[0]).not.toContain('hunter2');
  });
});
