import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('waits the configured time on SIGTERM and only then closes', () => {
    withDelay(5_000);
    const { handlers } = captureHandlers();
    const app = fakeApp();

    installGracefulShutdown(app);
    // Nest must NOT get its own handler, or it would close in parallel with the wait
    expect(app.enableShutdownHooks).not.toHaveBeenCalled();

    handlers.SIGTERM('SIGTERM');

    // Still fully healthy: this is the window in which the load balancer deregisters
    vi.advanceTimersByTime(4_999);
    expect(app.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('registers for SIGINT as well', () => {
    withDelay(1_000);
    const { handlers } = captureHandlers();
    const app = fakeApp();

    installGracefulShutdown(app);
    handlers.SIGINT('SIGINT');
    vi.advanceTimersByTime(1_001);

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

  it('caps an implausible delay instead of guaranteeing a SIGKILL', () => {
    // 10 minutes is longer than any orchestrator grace period, so waiting it out cannot end
    // gracefully — the cap turns a typo into a late shutdown rather than a killed one.
    withDelay(600_000);
    const { handlers } = captureHandlers();
    const app = fakeApp();

    installGracefulShutdown(app);
    handlers.SIGTERM('SIGTERM');

    vi.advanceTimersByTime(60_001);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('does not let a failing close go unreported', async () => {
    withDelay(100);
    const { handlers } = captureHandlers();
    const app = fakeApp();
    app.close.mockRejectedValue(new Error('teardown blew up'));

    installGracefulShutdown(app);
    handlers.SIGTERM('SIGTERM');
    vi.advanceTimersByTime(101);

    // The rejection is handled inside the helper; nothing escapes as an unhandled rejection
    await expect(Promise.resolve()).resolves.toBeUndefined();
    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
