import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * @regression   11.39.x — "does not let a failing close go unreported" asserted
 *   `await expect(Promise.resolve()).resolves.toBeUndefined()`, which is true whatever the
 *   helper does; a close whose rejection vanished silently passed it. The same tests also
 *   never awaited the helper's `.then`/`.catch` chain, so its log landed after the test —
 *   sometimes after the whole file, during worker teardown, surfacing as
 *   `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` and blamed
 *   on whichever spec happened to run last, with all tests reported as passed.
 * @seen-failing Registered as mutations `graceful-shutdown-rejection-unreported` (drop the
 *   `.catch`) and `graceful-shutdown-cap-silent` (drop the cap warning) in
 *   tests/regression-mutations.json. The first was originally observed by sabotage: with the
 *   `.catch` removed, the PREVIOUS version of this suite stayed green at 7/7.
 */

import { ConfigService } from '../../src/core/common/services/config.service';
import { installGracefulShutdown } from '../../src/core/common/helpers/graceful-shutdown.helper';

/**
 * The delay is deliberately NOT a NestJS lifecycle hook, and that is the whole point of these
 * tests. Nest's `close()` runs `onModuleDestroy` → `beforeApplicationShutdown` → dispose →
 * `onApplicationShutdown`, so a hook-based delay waits AFTER every module is destroyed while the
 * socket still accepts requests — traffic answered by a gutted app. The wait therefore has to sit
 * in front of `close()`, in the signal handler, which is what is asserted here.
 */
function fakeApp() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    enableShutdownHooks: vi.fn(),
  } as any;
}

/** Capture the signal handlers the helper registers, without ever arming a real one */
function captureHandlers() {
  const handlers: Record<string, (signal: NodeJS.Signals) => void> = {};
  const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: any) => {
    handlers[event] = handler;
    return process;
  }) as any);
  return { handlers, spy };
}

function withDelay(delayMs: number | undefined) {
  vi.spyOn(ConfigService, 'getFastButReadOnly').mockImplementation(((key: string) =>
    key === 'shutdownDelayMs' ? delayMs : undefined) as any);
}

/**
 * Collect what the helper logs at `level`, and keep it out of the reporter.
 *
 * Two reasons, and the second one is why every close-triggering test below awaits its timers.
 * The helper reports the close through `logger.log` / `logger.error` in a `.then` / `.catch`,
 * i.e. one microtask AFTER `app.close()` settles. `vi.advanceTimersByTime` runs the timer
 * synchronously and does not drain those, so the log used to land once the test had already
 * finished — occasionally past the whole FILE, where vitest is tearing the worker down. That
 * surfaced as `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`,
 * blamed on whichever spec happened to be last, with all 2213 tests reported as passed.
 * `advanceTimersByTimeAsync` drains the microtasks, so the log belongs to the test that caused it.
 */
function captureLogger(level: 'error' | 'log' | 'warn') {
  const messages: string[] = [];
  vi.spyOn(Logger.prototype, level).mockImplementation(((message: unknown) => {
    messages.push(String(message));
  }) as any);
  return messages;
}

describe('installGracefulShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is plain enableShutdownHooks when no delay is configured', () => {
    withDelay(undefined);
    const { spy } = captureHandlers();
    const app = fakeApp();

    installGracefulShutdown(app);

    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
    // No signal handling of its own — Nest owns it, exactly as before this feature existed
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats a non-positive or nonsensical delay as "no delay"', () => {
    for (const value of [0, -1, Number.NaN, undefined]) {
      vi.restoreAllMocks();
      withDelay(value as number);
      const { spy } = captureHandlers();
      const app = fakeApp();

      installGracefulShutdown(app);

      expect(app.enableShutdownHooks, `delay ${String(value)}`).toHaveBeenCalledTimes(1);
      expect(spy, `delay ${String(value)}`).not.toHaveBeenCalled();
    }
  });

  it('waits the configured time on SIGTERM and only then closes', async () => {
    withDelay(5_000);
    const { handlers } = captureHandlers();
    const app = fakeApp();
    const logs = captureLogger('log');

    installGracefulShutdown(app);
    // Nest must NOT get its own handler, or it would close in parallel with the wait
    expect(app.enableShutdownHooks).not.toHaveBeenCalled();

    handlers.SIGTERM('SIGTERM');

    // Still fully healthy: this is the window in which the load balancer deregisters
    await vi.advanceTimersByTimeAsync(4_999);
    expect(app.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(logs).toContain('Shutdown complete');
  });

  it('registers for SIGINT as well', async () => {
    withDelay(1_000);
    const { handlers } = captureHandlers();
    const app = fakeApp();
    captureLogger('log');

    installGracefulShutdown(app);
    handlers.SIGINT('SIGINT');
    await vi.advanceTimersByTimeAsync(1_001);

    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('closes immediately on a second signal instead of making the operator wait twice', () => {
    withDelay(30_000);
    const { handlers } = captureHandlers();
    const app = fakeApp();

    installGracefulShutdown(app);
    handlers.SIGTERM('SIGTERM');
    expect(app.close).not.toHaveBeenCalled();

    handlers.SIGTERM('SIGTERM');
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('caps an implausible delay instead of guaranteeing a SIGKILL', async () => {
    // 10 minutes is longer than any orchestrator grace period, so waiting it out cannot end
    // gracefully — the cap turns a typo into a late shutdown rather than a killed one.
    withDelay(600_000);
    const { handlers } = captureHandlers();
    const app = fakeApp();
    const warnings = captureLogger('warn');
    captureLogger('log');

    installGracefulShutdown(app);
    handlers.SIGTERM('SIGTERM');

    await vi.advanceTimersByTimeAsync(60_001);
    expect(app.close).toHaveBeenCalledTimes(1);
    // The cap is only half the behaviour — an operator who never hears about it keeps the typo.
    expect(warnings.some((w) => w.includes('exceeds the 60000ms cap'))).toBe(true);
  });

  it('does not let a failing close go unreported', async () => {
    withDelay(100);
    const { handlers } = captureHandlers();
    const app = fakeApp();
    const errors = captureLogger('error');
    app.close.mockRejectedValue(new Error('teardown blew up'));

    installGracefulShutdown(app);
    handlers.SIGTERM('SIGTERM');
    await vi.advanceTimersByTimeAsync(101);

    expect(app.close).toHaveBeenCalledTimes(1);
    // The point of the test, and what it used to skip: the rejection is CAUGHT and REPORTED.
    // The previous assertion was `await expect(Promise.resolve()).resolves.toBeUndefined()`,
    // which is true no matter what the helper does — a failing close that vanished silently
    // would have passed it, which is the exact defect the test's name promises to catch.
    expect(errors).toEqual(['Shutdown failed: teardown blew up']);
  });
});
