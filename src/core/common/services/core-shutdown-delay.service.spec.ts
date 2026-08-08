import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from './config.service';
import { CoreShutdownDelayService } from './core-shutdown-delay.service';

function makeService(shutdownDelayMs?: number): CoreShutdownDelayService {
  return new CoreShutdownDelayService(new ConfigService({ shutdownDelayMs } as any));
}

describe('CoreShutdownDelayService', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
  });

  it('awaits the configured delay and logs once', async () => {
    const service = makeService(5000);
    let done = false;
    const pending = service.beforeApplicationShutdown().then(() => {
      done = true;
    });

    expect(logSpy).toHaveBeenCalledWith('delaying shutdown by 5000ms for load-balancer deregistration');
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it('does not delay or log when the delay is zero', async () => {
    await makeService(0).beforeApplicationShutdown();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does not delay or log when the option is unset', async () => {
    await makeService().beforeApplicationShutdown();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
