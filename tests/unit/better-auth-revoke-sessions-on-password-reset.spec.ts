/**
 * `betterAuth.emailAndPassword.revokeSessionsOnPasswordReset` — the opt-in that ends the sessions
 * which already existed when the user resets their password.
 *
 * WHY IT IS A FIRST-CLASS FIELD AND NOT JUST `options`
 * ----------------------------------------------------
 * Because a named field is validated (`=== true`, so a JSON-env string does not enable a
 * sign-out-everywhere behaviour), typed, and discoverable — none of which `options` offers.
 *
 * It used to be for a harsher reason: `config.options` was merged with a SHALLOW spread, so an
 * `options.emailAndPassword` REPLACED the whole block including the scrypt `password.hash` /
 * `password.verify` pair, and every credential in the database stopped verifying with nothing said
 * at boot. `emailAndPassword` is deep-merged now, with `password` re-applied as the base, so that
 * particular trap is closed — the last test in this file pins the merge that closes it. The field
 * stays first-class on its own merits.
 *
 * WHY OFF BY DEFAULT
 * ------------------
 * It is a behaviour change for an existing deployment: after a reset the user is signed out
 * everywhere, including on the devices they still hold. Worth choosing, not worth inflicting on
 * upgrade — hence `=== true`, which also means a truthy-but-not-`true` value from a JSON env
 * (`NSC__*`) does not silently enable it.
 *
 * The instance is built with a fake MongoDB `db`: `betterAuth()` only wraps the adapter at
 * construction time, so this stays a pure unit test — same approach as
 * `better-auth-secure-cookies.spec.ts`.
 *
 * @regression   11.36.0 — not a shipped defect but a new option, and this proves the wiring is not
 *   vacuous: a field that never reaches `instance.options` would leave a reset silently keeping the
 *   attacker's session alive while the config says otherwise, which is worse than not offering the
 *   option at all.
 * @seen-failing Hard-code `revokeSessionsOnPasswordReset: false` in the `emailAndPassword` block of
 *   `src/core/modules/better-auth/better-auth.config.ts` — registered as mutation
 *   `betterauth-revoke-sessions-not-wired` in `tests/regression-mutations.json`. Only the
 *   enabled case goes red; every default/off case stays green, so the failure is the wiring and not
 *   a broken fixture.
 */
import { describe, expect, it } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';

/** Minimal MongoDB `Db` stand-in — `mongodbAdapter(db)` only stores the reference. */
const fakeDb: any = {
  collection: () => ({
    createIndex: async () => undefined,
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';

/** Read back the `emailAndPassword` block Better-Auth was actually constructed with. */
function buildEmailAndPassword(config: Record<string, unknown>): Record<string, any> {
  const result = createBetterAuthInstance({ config: { enabled: true, secret: VALID_SECRET, ...config } as any, db: fakeDb });
  expect(result).not.toBeNull();
  return (result!.instance as any).options.emailAndPassword as Record<string, any>;
}

describe('betterAuth.emailAndPassword.revokeSessionsOnPasswordReset', () => {
  it('is off when nothing is configured — an upgrade does not change behaviour', () => {
    expect(buildEmailAndPassword({}).revokeSessionsOnPasswordReset).toBe(false);
  });

  it('is off when emailAndPassword is configured but the flag is not', () => {
    // The neighbouring keys must not drag it in.
    const block = buildEmailAndPassword({ emailAndPassword: { disableSignUp: true } });

    expect(block.revokeSessionsOnPasswordReset).toBe(false);
    expect(block.disableSignUp).toBe(true);
  });

  it('reaches the Better-Auth instance when enabled', () => {
    // The property under test. Better-Auth reads exactly this key on its reset routes; if the
    // framework never forwards it, the config is decoration.
    expect(buildEmailAndPassword({ emailAndPassword: { revokeSessionsOnPasswordReset: true } })
      .revokeSessionsOnPasswordReset).toBe(true);
  });

  it('stays off on an explicit false', () => {
    expect(buildEmailAndPassword({ emailAndPassword: { revokeSessionsOnPasswordReset: false } })
      .revokeSessionsOnPasswordReset).toBe(false);
  });

  it('stays off on a truthy value that is not exactly true', () => {
    // `NSC__*` and NEST_SERVER_CONFIG carry JSON, and a hand-written `"true"` is a string. Enabling
    // a sign-out-everywhere behaviour on a near-miss would be the wrong direction to guess in.
    expect(buildEmailAndPassword({ emailAndPassword: { revokeSessionsOnPasswordReset: 'yes' } })
      .revokeSessionsOnPasswordReset).toBe(false);
  });

  it('does not disturb the scrypt password pair', () => {
    // The pair is what verifies every stored credential. It has to survive alongside the new key.
    const block = buildEmailAndPassword({ emailAndPassword: { revokeSessionsOnPasswordReset: true } });

    expect(typeof block.password?.hash).toBe('function');
    expect(typeof block.password?.verify).toBe('function');
  });

  describe('the hazard the deep-merge closes', () => {
    it('keeps the scrypt pair when the flag is routed through options instead', () => {
      // This used to assert `password` was UNDEFINED — the shallow-merge contract, pinned as a
      // known hazard. Going through `options` took the password functions with it and broke every
      // login, silently and at runtime. `emailAndPassword` is deep-merged now and `password` is
      // re-applied as the base, so the wrong-but-plausible config no longer costs a deployment its
      // logins. Reaching for the named field is still the better habit.
      const block = buildEmailAndPassword({
        options: { emailAndPassword: { enabled: true, revokeSessionsOnPasswordReset: true } },
      });

      expect(block.revokeSessionsOnPasswordReset).toBe(true);
      expect(typeof block.password?.hash).toBe('function');
      expect(typeof block.password?.verify).toBe('function');
    });
  });
});
