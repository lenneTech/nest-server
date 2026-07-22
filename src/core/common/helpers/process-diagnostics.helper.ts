/**
 * Process-level exit diagnostics.
 *
 * A Node API can die "silently": the dev runner (`nodemon`, `lt dev`) prints only
 * `app crashed - waiting for file changes before starting...` with NO stacktrace, and in a
 * container the process simply vanishes. A missing stacktrace means the process was killed by a
 * SIGNAL rather than throwing — either an OS OOM SIGKILL (uncatchable) or an EXTERNAL
 * SIGTERM/SIGINT (an orchestrator's stop, another tool's pkill, `lt dev down`, Ctrl-C).
 *
 * `installProcessDiagnostics()` makes the exit reason visible:
 * - `unhandledRejection` is logged but NOT fatal by default — a rejected fire-and-forget promise
 *   (e.g. a transactional email failing on an auth path outside a try/catch) must never take the
 *   whole server down. Set `onUnhandledRejection: 'exit'` to restore Node's own fail-fast.
 * - `uncaughtException` is logged with a clear marker and then exits(1) — process state is unknown
 *   after one, so crashing and being restarted is the safe behaviour, but with a guaranteed log
 *   line above the runner's "app crashed".
 * - a NON-ZERO `exit` code is logged (a clean exit needs no explanation and no extra line).
 * - termination signals are logged as EXTERNAL terminations so they stop masquerading as
 *   in-process crashes.
 *
 * **Deliberately NOT handled: process `warning`s.** Node prints them to stderr itself, and adding a
 * listener does not replace that — it appends a second, strictly worse copy (Node's own line
 * carries the warning `name` and the `--trace-warnings` hint; ours would not). Duplicating it would
 * double the volume on the one path that fires during normal operation. Use `--trace-warnings`
 * instead when a warning needs a stack.
 *
 * **Call it from `main.ts`, not from a module.** It is deliberately NOT wired into
 * `CoreModule.forRoot()`:
 * 1. It must run BEFORE `NestFactory.create()` to catch failures during module construction —
 *    inside a module it would already be too late.
 * 2. It installs a `process.exit(1)` path. Registering that from a module would also arm it inside
 *    `Test.createTestingModule()`, where an uncaught exception would then kill the whole test
 *    runner instead of failing one spec.
 *
 * **Known limitation:** it cannot cover failures during synchronous *import* evaluation of
 * `main.ts` (a throwing `config.env.ts`, an SWC temporal-dead-zone `ReferenceError`), because
 * imports are hoisted above the first statement of `bootstrap()`. That class of failure is loud
 * anyway — Node prints it with a full stack. Only a `--require` preload module could cover it.
 *
 * **Pair it with `enableShutdownHooks()`.** On its own this helper labels a signal; it does not
 * make the process terminate on one. In a container Node is PID 1, where a userspace re-raise with
 * the default disposition is silently discarded by the kernel — the event loop stays busy and
 * `docker stop` waits out its grace period before SIGKILL. `app.enableShutdownHooks()` is what
 * actually drains the loop, and this helper then correctly defers to it.
 *
 * @example
 * ```typescript
 * // src/main.ts
 * import { handleFatalBootstrapError, installProcessDiagnostics } from '@lenne.tech/nest-server';
 *
 * async function bootstrap() {
 *   installProcessDiagnostics();
 *   const server = await NestFactory.create<NestExpressApplication>(ServerModule);
 *   server.enableShutdownHooks(); // required for a graceful container stop
 *   await server.listen(envConfig.port);
 * }
 *
 * // A rejection here is a fatal startup failure — exit instead of leaving a zombie process.
 * bootstrap().catch(handleFatalBootstrapError);
 * ```
 */

import { writeSync } from 'node:fs';

import { redactSensitiveText } from './logging.helper';

/**
 * Hard cap for a single diagnostic line.
 *
 * `describeError` renders a caller-controlled value — a rejected promise can carry an object whose
 * `toString()` returns megabytes. One unbounded synchronous write would stall the event loop for
 * its whole duration.
 */
const MAX_DIAGNOSTIC_CHARS = 16_384;

/** Minimal logger surface — `console` satisfies it. */
export interface DiagnosticsLogger {
  /**
   * Sink for TERMINAL diagnostics (uncaught exception, non-zero exit, signals, fatal bootstrap).
   * These are written immediately before the process goes away, so the default implementation is
   * synchronous.
   */
  error: (message: string) => void;
  /**
   * Sink for NON-TERMINAL diagnostics (an unhandled rejection while the server keeps serving).
   * Defaults to `error` when omitted. The default implementation is ASYNCHRONOUS on purpose — see
   * {@link defaultDiagnosticsLogger}.
   */
  warn?: (message: string) => void;
}

/**
 * Caps and redacts a diagnostic line before it reaches any sink.
 *
 * Redaction matters because this sink deliberately bypasses the Nest logger, and with it every
 * structured-log redaction a consumer has configured. The framework's own `redactSensitiveText`
 * is the same one the Hub log buffer uses, so a connection string or bearer token in an error
 * message is masked here exactly as it would be there.
 *
 * @param message - The raw diagnostic line
 * @returns The line, truncated to {@link MAX_DIAGNOSTIC_CHARS} and redacted
 */
function formatDiagnostic(message: string): string {
  // Cap BEFORE redacting: only the truncated head is ever emitted, so redacting the discarded
  // tail would be wasted work on the very path that must stay cheap.
  const capped =
    message.length > MAX_DIAGNOSTIC_CHARS ? `${message.slice(0, MAX_DIAGNOSTIC_CHARS)}… [truncated]` : message;
  return redactSensitiveText(capped);
}

/**
 * Default diagnostic sink.
 *
 * `error` is a SYNCHRONOUS write to fd 2 (stderr). `console.error` is asynchronous on a pipe, so a
 * last-gasp line written immediately before `process.exit()` or a signal re-raise can be truncated
 * — silently dropping the very line this helper exists to emit. `writeSync` completes before we
 * terminate.
 *
 * `warn` is deliberately ASYNCHRONOUS. A synchronous write blocks the whole event loop until the
 * pipe drains, so on the one path that fires while the server is still serving — an unhandled
 * rejection, potentially once per request — a stalled log collector would stall the entire process.
 * Nothing is about to terminate there, so there is no last-gasp guarantee to preserve.
 *
 * Both bypass the Nest logger (including any JSON logger configured for production): these lines
 * must survive the exact moments when the DI container is being torn down or is already gone.
 * Structured-log consumers see them as plain stderr records. Pass a custom `logger` if they must be
 * routed elsewhere.
 */
const defaultDiagnosticsLogger: DiagnosticsLogger = {
  error: (message: string) => {
    try {
      writeSync(2, `${message}\n`);
    } catch {
      // EBADF (fd 2 closed), EPIPE (reader exited — routine under `| head` or a detached log
      // driver), EAGAIN (non-blocking pipe under backpressure). A diagnostic line is best-effort:
      // throwing here would escalate. Worse, a throw raised INSIDE the uncaughtException handler
      // makes Node exit 7 and print its own "throw inside handler" message instead of the original
      // error — inverting the entire purpose of this helper.
    }
  },
  warn: (message: string) => {
    console.error(message);
  },
};

/** Options for {@link installProcessDiagnostics}. All dependencies are injectable for testing. */
export interface ProcessDiagnosticsOptions {
  /** Process-exit function. Defaults to `process.exit`. Injected in tests. */
  exit?: (code: number) => void;
  /** Logger for the diagnostic lines. Defaults to a synchronous stderr sink. */
  logger?: DiagnosticsLogger;
  /**
   * What to do on an unhandled rejection.
   *
   * - `'log'` (default): log and continue — a fire-and-forget failure must not take the server down.
   * - `'exit'`: log and `exit(1)`, restoring Node >= 15's own `--unhandled-rejections=throw`
   *   default for deployments that prefer a clean restart over serving from an unknown state.
   *
   * @default 'log'
   */
  onUnhandledRejection?: 'exit' | 'log';
  /** Re-raise a signal with its default disposition. Defaults to `process.kill(process.pid, signal)`. */
  reraise?: (signal: NodeJS.Signals) => void;
  /**
   * How long to wait for another signal handler (e.g. `enableShutdownHooks()`) to finish the
   * shutdown before forcing an exit. `0` disables the watchdog.
   *
   * Without it, a co-listener that never terminates makes SIGTERM a permanent no-op while the log
   * line claims the process is going down — only SIGKILL would still work.
   *
   * @default 30000
   */
  shutdownTimeoutMs?: number;
  /** Event target to attach handlers to. Defaults to the global `process`. Injected in tests. */
  target?: NodeJS.EventEmitter;
}

/**
 * Signals whose default disposition is to terminate the process.
 *
 * `SIGUSR2` is deliberately absent: nodemon uses it to trigger a restart, and attaching a listener
 * overrides its disposition. Labelling a restart is not worth the risk of changing how it behaves.
 */
const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];

/** Guards against double-installation (e.g. an accidental second bootstrap call). */
const installedTargets = new WeakSet<object>();

/**
 * Renders any thrown value as a loggable string, preserving the stack when there is one.
 *
 * @param value - The thrown / rejected value (not necessarily an `Error`)
 * @returns The stack for an `Error` (it already begins with `name: message`), `String(value)` otherwise
 */
function describeError(value: unknown): string {
  if (value instanceof Error) {
    // `stack` already starts with `${name}: ${message}` — prefixing the message again would print
    // it twice. Fall back to that same shape when a stack is missing.
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  return String(value);
}

/**
 * Attaches the process-level diagnostic handlers. Idempotent per target — calling it twice does
 * not stack duplicate listeners.
 *
 * Call this as the first statement of `bootstrap()`, before `NestFactory.create()`. See the module
 * docblock for why it must not live inside `CoreModule.forRoot()`.
 *
 * @param options - Injectable dependencies; defaults target the real `process`
 *
 * @example
 * installProcessDiagnostics();
 * installProcessDiagnostics({ onUnhandledRejection: 'exit' }); // restore Node's fail-fast
 */
export function installProcessDiagnostics(options: ProcessDiagnosticsOptions = {}): void {
  const target: NodeJS.EventEmitter = options.target ?? process;
  const logger: DiagnosticsLogger = options.logger ?? defaultDiagnosticsLogger;
  const exit: (code: number) => void = options.exit ?? ((code: number) => process.exit(code));
  const reraise: (signal: NodeJS.Signals) => void =
    options.reraise ?? ((signal: NodeJS.Signals) => process.kill(process.pid, signal));
  const onUnhandledRejection: 'exit' | 'log' = options.onUnhandledRejection ?? 'log';
  const shutdownTimeoutMs: number = options.shutdownTimeoutMs ?? 30_000;

  // Non-terminal lines go through `warn` (async, cannot block the event loop); everything else
  // through `error` (sync, survives teardown). A custom logger may omit `warn` — then it opts into
  // its own `error` for both.
  const logTerminal = (message: string): void => logger.error(formatDiagnostic(message));
  const logNonTerminal = (message: string): void => (logger.warn ?? logger.error)(formatDiagnostic(message));

  if (installedTargets.has(target)) {
    return;
  }
  installedTargets.add(target);

  target.on('unhandledRejection', (reason: unknown) => {
    if (onUnhandledRejection === 'exit') {
      logTerminal(`[unhandledRejection] ${describeError(reason)}`);
      exit(1);
      return;
    }
    logNonTerminal(`[unhandledRejection] ${describeError(reason)}`);
  });

  target.on('uncaughtException', (error: unknown) => {
    logTerminal(`[uncaughtException] ${describeError(error)}`);
    exit(1);
  });

  target.on('exit', (code: unknown) => {
    // A clean exit is not a diagnostic. Logging it unconditionally puts a line under every CLI
    // script and every graceful shutdown, which trains readers to ignore the marker.
    if (code !== 0) {
      logTerminal(`[exit] process exiting with code ${String(code)}`);
    }
  });

  for (const signal of TERMINATION_SIGNALS) {
    const handler = (received: NodeJS.Signals): void => {
      // Attaching a listener overrode Node's default terminate disposition. When we are the only
      // listener, re-raise the signal so the process still terminates as it would have. If another
      // handler is also registered (e.g. `app.enableShutdownHooks()`), let it own the exit.
      const alone = target.listenerCount(signal) <= 1;
      logTerminal(
        `[signal] received ${received} — external termination (not an in-process crash)${
          alone ? '' : ' — another handler owns the shutdown'
        }`,
      );

      if (alone) {
        target.removeListener(signal, handler);
        reraise(received);
        return;
      }

      if (shutdownTimeoutMs > 0) {
        // The co-listener owns the exit — but it may never reach one. Do not stay hostage forever:
        // an unkillable-by-SIGTERM process is worse than an ungraceful one.
        const watchdog = setTimeout(() => {
          logTerminal(`[signal] shutdown watchdog expired after ${shutdownTimeoutMs}ms — forcing exit`);
          exit(1);
        }, shutdownTimeoutMs);
        // Never keep the event loop alive purely for the watchdog.
        watchdog.unref?.();
      }
    };
    target.on(signal, handler);
  }
}

/** Options for {@link handleFatalBootstrapError}. All dependencies are injectable for testing. */
export interface FatalBootstrapErrorOptions {
  /** Process-exit function. Defaults to `process.exit`. Injected in tests. */
  exit?: (code: number) => void;
  /** Logger for the diagnostic line. Defaults to a synchronous stderr sink. */
  logger?: DiagnosticsLogger;
}

/**
 * Terminal handler for a failed server bootstrap. Use it as the `catch` of the fire-and-forget
 * `bootstrap()` call in `main.ts`.
 *
 * Without it, a rejection from `bootstrap()` (e.g. `server.listen` failing with EADDRINUSE, or a
 * MongoDB connection error) surfaces as a mere `unhandledRejection` — which the runtime guard logs
 * but does NOT act on, leaving a ZOMBIE process that is "alive" but listening on nothing. A startup
 * failure is fatal: log it loudly and exit so the supervisor (nodemon in dev, the container runtime
 * in production) restarts a clean instance.
 *
 * @param error - The rejection value from `bootstrap()`
 * @param options - Injectable dependencies; defaults exit the real process
 *
 * @example
 * bootstrap().catch(handleFatalBootstrapError);
 */
export function handleFatalBootstrapError(error: unknown, options: FatalBootstrapErrorOptions = {}): void {
  const logger: DiagnosticsLogger = options.logger ?? defaultDiagnosticsLogger;
  const exit: (code: number) => void = options.exit ?? ((code: number) => process.exit(code));
  logger.error(formatDiagnostic(`[bootstrap] fatal startup error — exiting: ${describeError(error)}`));
  exit(1);
}
