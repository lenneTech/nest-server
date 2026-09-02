/**
 * The safety property of the in-flight password-reset registry.
 *
 * The registry's own docstring makes a concurrency claim: *"the context lives exactly as long as
 * the handler call, so no other request can observe it"*. It carries a password-equivalent value
 * across an async boundary, and if that claim were wrong the failure mode is mirroring user A's
 * password into user B's legacy account — a credential cross-contamination that no type-checker
 * and no integration test would surface, because both requests succeed.
 *
 * Two reviewers confirmed the property by reading the code. That is worth something and is not
 * the same as an assertion: reading proves it holds today, a test keeps it holding. `AsyncLocalStorage`
 * semantics are subtle enough that a refactor — hoisting the `run()` one call further out, awaiting
 * something between the store and the read — can break it without looking like it did.
 *
 * @regression   11.38.0 — the registry was introduced with its concurrency claim stated in prose
 *   and asserted nowhere.
 * @seen-failing Registered mutation `reset-registry-leaks-across-requests` in
 *   tests/regression-mutations.json — replaces the AsyncLocalStorage store with a module-level
 *   variable, which is what the registry would be if somebody "simplified" it. The interleaving
 *   test then observes the other request's password.
 */

import { describe, expect, it } from 'vitest';

import {
  getInFlightResetPassword,
  runWithResetPassword,
} from '../../src/core/modules/better-auth/core-better-auth-password-reset.registry';

/** Yields to the event loop, so two "requests" genuinely interleave rather than run in sequence. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('in-flight password-reset registry', () => {
  it('reads back the value inside the context', () => {
    const seen = runWithResetPassword('hash-a', () => getInFlightResetPassword());

    expect(seen).toBe('hash-a');
  });

  it('hands the value out exactly once', () => {
    // Deliberate: the legacy mirror is the only legitimate reader and it reads once, so a second
    // read can only serve something that should not have it. An AsyncLocalStorage store is
    // retained by any async resource created inside the `run()` that outlives it — clearing on
    // read bounds that to the moment the mirror actually runs.
    const reads = runWithResetPassword('hash-a', () => [getInFlightResetPassword(), getInFlightResetPassword()]);

    expect(reads).toEqual(['hash-a', undefined]);
  });

  it('is undefined outside any context', () => {
    // "Not a reset we saw the body of" — never "no password". The caller must skip the mirror
    // rather than guess, because a wrong bcrypt write locks the account out of the legacy path.
    expect(getInFlightResetPassword()).toBeUndefined();
  });

  it('survives an await before the read, and is gone after the context ends', async () => {
    await runWithResetPassword('hash-a', async () => {
      // The hook runs after Better-Auth has already awaited its own work, so the value has to
      // survive suspension points inside the handler call.
      await tick();
      expect(getInFlightResetPassword()).toBe('hash-a');
    });

    expect(getInFlightResetPassword()).toBeUndefined();
  });

  it('keeps two interleaved resets apart', async () => {
    // THE claim. Both "requests" are in flight at the same time and yield to each other between
    // every read; each must only ever see its own value.
    const observations: Record<string, string | undefined> = {};

    const request = async (label: 'a' | 'b', password: string): Promise<void> => {
      await runWithResetPassword(password, async () => {
        // Yield repeatedly BEFORE reading, so the two requests are genuinely interleaved at the
        // moment each one looks — the shape in which a shared variable hands over the wrong value.
        await tick();
        await tick();
        observations[label] = getInFlightResetPassword();
        await tick();
      });
    };

    await Promise.all([request('a', 'hash-for-user-a'), request('b', 'hash-for-user-b')]);

    expect(observations.a, 'request A must see its own password').toBe('hash-for-user-a');
    expect(observations.b, 'request B must see its own password').toBe('hash-for-user-b');
  });

  it('does not leak into work started outside the context', async () => {
    // A concurrent operation that is not part of any reset must see nothing, even while a reset
    // is mid-flight. This is the shape that would mirror a password onto the wrong account.
    let observedByBystander: string | undefined = 'not-run';

    await Promise.all([
      runWithResetPassword('hash-a', async () => {
        await tick();
        await tick();
      }),
      (async () => {
        await tick();
        observedByBystander = getInFlightResetPassword();
      })(),
    ]);

    expect(observedByBystander).toBeUndefined();
  });

  it('nests without the inner value escaping to the outer scope', async () => {
    const seen: (string | undefined)[] = [];

    await runWithResetPassword('outer', async () => {
      await runWithResetPassword('inner', async () => {
        seen.push(getInFlightResetPassword());
      });
      // The outer context is untouched by the inner one — its own single read still works.
      seen.push(getInFlightResetPassword());
    });

    expect(seen).toEqual(['inner', 'outer']);
  });
});
