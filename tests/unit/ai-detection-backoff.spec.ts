import { describe, expect, it, vi } from 'vitest';

import { CoreAiService } from '../../src/core/modules/ai/services/core-ai.service';

/**
 * Lazy capability detection runs from `prepareRun` whenever a flag is undefined —
 * i.e. inline on an ORDINARY user prompt, ahead of `checkRateLimit` and outside
 * budget accounting. A THROWN detection deliberately persists nothing, so without a
 * backoff it re-probes on every single prompt: an endpoint that answers the first
 * probe and times out on the retry then burns a full timeout per user prompt,
 * indefinitely.
 */
describe('capability-detection backoff', () => {
  /** A service reduced to what the lazy-detection branch of `prepareRun` touches. */
  function detectService(detect: () => Promise<any>) {
    const service: any = Object.create(CoreAiService.prototype);
    service.connectionService = { detectAndPersistCapabilities: vi.fn(detect) };
    (service as any).detectionBackoff = new Map<string, number>();
    (service as any).detectionBackoffMs = 5 * 60 * 1000;
    return service;
  }

  it('suppresses a re-probe after a THROWN detection, then lets it through again', () => {
    // A thrown detection persists nothing, on purpose — a transient blip must not
    // pin a wrong flag forever. Without the backoff that correctness costs one
    // re-probe per user prompt, ahead of the rate limiter and outside the budget.
    const service = detectService(async () => undefined);

    expect(service.detectionSuppressed('c1')).toBe(false);
    service.rememberFailedDetection('c1');
    expect(service.detectionSuppressed('c1')).toBe(true);
    expect(service.detectionSuppressed('other')).toBe(false);

    // Deadline passed → probe again. Checking the STORED DEADLINE rather than mere
    // presence is the whole point: a bare `has()` would keep the connection
    // suppressed until an unrelated failure happened to sweep the map, turning a
    // five-minute backoff into a permanent one.
    service.detectionBackoff.set('c1', Date.now() - 1);
    expect(service.detectionSuppressed('c1')).toBe(false);
    expect(service.detectionBackoff.has('c1')).toBe(false);
  });

  it('does not grow unboundedly — expired entries are swept on write', () => {
    const service = detectService(async () => undefined);
    service.detectionBackoff.set('stale', Date.now() - 1);
    service.rememberFailedDetection('fresh');

    expect([...service.detectionBackoff.keys()]).toEqual(['fresh']);
  });
});
