import { Logger } from '@nestjs/common';
import { vi } from 'vitest';

/**
 * Capture the Nest `Logger.error` output a spec EXPECTS, instead of printing it.
 *
 * Two reasons, and the second one is why this exists as a shared helper rather than as three
 * ad-hoc spies.
 *
 * 1. **It is noise.** `tests/setup.ts` already restricts the logger to `error`/`fatal`
 *    precisely because expected framework output is "correct production behaviour but pure
 *    noise in test runs". A spec that deliberately drives a failure path — SMTP down, Redis
 *    refused, GridFS chunk missing — produces exactly that noise on a GREEN run, stack traces
 *    included. This repo's own argument applies: output that is always there is output nobody
 *    reads, and it hides the line that matters on the run that is actually failing.
 *
 * 2. **It removes a flake, and this is the load-bearing half.** vitest forwards every console
 *    write from the worker to the main thread as an `onUserConsoleLog` RPC. At worker teardown
 *    `execute()` does NOT await those calls — it REJECTS whatever is still in flight:
 *
 *        rpc.$rejectPendingCalls(({ method, reject }) =>
 *          reject(new EnvironmentTeardownError(`Closing rpc while "${method}" was pending`)))
 *
 *    So a log written by the LAST test of a file can still be travelling when cleanup runs, and
 *    the whole run then fails with every test green. It is a race, not a late log: the specs
 *    below all `await` their calls properly. Measured at roughly 1 run in 10 of the unit suite,
 *    which is enough to make `pnpm run check` unreliable while telling you nothing.
 *
 *    vitest 4.1.11 is the newest 4.x, so there is no patch to take. The only lever on this side
 *    is to not produce the output: no console write, no RPC, no race.
 *
 * **Prefer asserting over discarding.** The returned array holds what was logged, so a spec can
 * turn expected noise into coverage — "the degradation is REPORTED" is behaviour worth pinning,
 * and several of these messages document a fallback a reader would otherwise never see proven.
 *
 * Only `error` is captured: `warn`/`log` are already off via `Logger.overrideLogger`, and
 * `restoreMocks: true` (vitest.config.ts) undoes the spy after every test, so a REAL error from
 * an unexpected path in the next test still reaches the reporter.
 *
 * @param level - which sink to capture; defaults to `error`
 * @returns the collected messages, in order
 */
export function captureExpectedLogs(level: 'error' | 'fatal' = 'error'): string[] {
  const messages: string[] = [];
  vi.spyOn(Logger.prototype, level).mockImplementation(((message: unknown) => {
    messages.push(String(message));
  }) as never);
  return messages;
}
