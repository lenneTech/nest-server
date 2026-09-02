/**
 * How the native password-reset flow is switched on, and what protects the credential hashing
 * while it is.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The presence of `emailAndPassword.sendResetPassword` is the entire on/off switch: without it
 * Better-Auth answers `RESET_PASSWORD_DISABLED` and no reset mail is ever sent. A refactor that
 * dropped the conditional spread would silently take password recovery away from every consumer
 * and pass every other test in the repo. Nothing asserted it before.
 *
 * These cases drive the REAL `createBetterAuthInstance()` and read the block back off
 * `instance.options`, rather than a local re-implementation of the merge — a hand copy keeps
 * passing when production changes, which is the failure mode this file is meant to catch.
 *
 * @regression   11.36.1 — `options.emailAndPassword` was merged with a SHALLOW spread, so setting
 *   it for any unrelated reason (a `sendResetPassword` callback, `maxPasswordLength`) replaced the
 *   whole block including the scrypt `password.hash` / `password.verify` pair the framework
 *   installs. Better-Auth then fell back to its own hasher, every stored credential stopped
 *   verifying, and every user of that deployment was locked out at once — at runtime, with nothing
 *   in the logs. The README recommended exactly that shape.
 * @seen-failing Drop `...base` from the `emailAndPassword` merge in
 *   `src/core/modules/better-auth/better-auth.config.ts` — registered as mutation
 *   `betterauth-emailandpassword-shallow-merge` in `tests/regression-mutations.json`. The
 *   scrypt-pair cases go red; the grafting cases stay green, so the failure is the merge and not a
 *   broken fixture.
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

const noopSender = async () => undefined;

/** Read back the `emailAndPassword` block Better-Auth was actually constructed with. */
function buildBlock(
  config: Record<string, unknown> = {},
  options: { onPasswordReset?: (data: any) => Promise<void>; sendResetPasswordEmail?: typeof noopSender } = {
    sendResetPasswordEmail: noopSender,
  },
): Record<string, any> {
  const result = createBetterAuthInstance({
    config: { enabled: true, secret: VALID_SECRET, ...config } as any,
    db: fakeDb,
    ...options,
  } as any);
  expect(result).not.toBeNull();
  return (result!.instance as any).options.emailAndPassword as Record<string, any>;
}

describe('the legacy-store mirror hook', () => {
  // `onPasswordReset` is what mirrors an applied IAM reset into the legacy bcrypt store. It is
  // proven end-to-end by tests/stories/password-reset-parity.e2e-spec.ts; what THIS file adds is
  // the wiring seen from the real constructed instance, and one property the e2e cannot reach:
  // that a project's own hook cannot displace the framework's.

  it('grafts onPasswordReset when a callback is supplied', () => {
    const block = buildBlock({}, { onPasswordReset: async () => undefined, sendResetPasswordEmail: noopSender });

    expect(typeof block.onPasswordReset).toBe('function');
  });

  it('omits it entirely when no callback is supplied', () => {
    // Better-Auth resolves the hook by presence, so an explicitly-undefined key would read as
    // "declared, does nothing" rather than "not declared".
    const block = buildBlock();

    expect('onPasswordReset' in block && block.onPasswordReset !== undefined).toBe(false);
  });

  it('CHAINS a project hook after the framework one instead of letting it replace it', async () => {
    // The asymmetry to `password`, where an explicit override wins: a hasher is a choice, a
    // credential-store mirror is not. A project has a legitimate motive to add its own hook
    // (audit log, notification mail) — and a spread would then silently drop the mirror,
    // restoring the pre-11.38.0 defect in which the OLD password stays valid on the legacy path.
    const order: string[] = [];
    const block = buildBlock(
      { options: { emailAndPassword: { onPasswordReset: async () => void order.push('project') } } },
      { onPasswordReset: async () => void order.push('framework'), sendResetPasswordEmail: noopSender },
    );

    await block.onPasswordReset({ user: { email: 'x@test.com', id: 'x' } });

    expect(order, 'both hooks must run, framework first').toEqual(['framework', 'project']);
  });
});

describe('password-reset hook grafting', () => {
  it('grafts sendResetPassword when a callback is supplied — this is what enables the flow', () => {
    expect(typeof buildBlock().sendResetPassword).toBe('function');
  });

  it('withholds sendResetPassword when no callback is supplied', () => {
    // Direct callers of createBetterAuthInstance only. CoreBetterAuthModule ALWAYS supplies one
    // (it handles the missing-mail-service case inside the callback), so this branch is not the
    // safety valve for a mail-less deployment — `passwordReset: false` below is.
    expect(buildBlock({}, {}).sendResetPassword).toBeUndefined();
  });

  it('withholds sendResetPassword when emailAndPassword.passwordReset is false', () => {
    // The real off switch: for deployments whose reset policy is support-mediated or SSO-primary
    // and which do not want an unauthenticated, token-minting, mail-sending endpoint at all.
    expect(buildBlock({ emailAndPassword: { passwordReset: false } }).sendResetPassword).toBeUndefined();
  });

  it('keeps the flow on for any other passwordReset value, including undefined', () => {
    expect(typeof buildBlock({ emailAndPassword: { passwordReset: true } }).sendResetPassword).toBe('function');
    expect(typeof buildBlock({ emailAndPassword: {} }).sendResetPassword).toBe('function');
  });
});

describe('emailAndPassword deep-merge protects the credential hashing', () => {
  it('keeps the native scrypt pair when options set an unrelated key', () => {
    const block = buildBlock({ options: { emailAndPassword: { maxPasswordLength: 128 } } });

    expect(typeof block.password?.hash).toBe('function');
    expect(typeof block.password?.verify).toBe('function');
    expect(block.maxPasswordLength).toBe(128);
  });

  it('preserves the other base keys rather than replacing the block', () => {
    const block = buildBlock({
      emailAndPassword: { disableSignUp: true },
      options: { emailAndPassword: { maxPasswordLength: 128 } },
    });

    expect(block.enabled).toBe(true);
    expect(block.disableSignUp).toBe(true);
  });

  it('still lets an EXPLICIT password override win, leaving the untouched half intact', () => {
    const customHash = async () => 'custom';
    const block = buildBlock({ options: { emailAndPassword: { password: { hash: customHash } } } });

    expect(block.password.hash).toBe(customHash);
    // The half nobody overrode survives instead of becoming undefined.
    expect(typeof block.password.verify).toBe('function');
  });

  it('ignores an explicitly-undefined password half instead of unseating the native one', () => {
    // Object spread copies an explicitly-undefined value as a PRESENT key, and Better-Auth resolves
    // `password?.hash || hashPassword`. Spreading would therefore switch the hasher for WRITES while
    // nest-server's scrypt verify still handled READS — an asymmetric pair, so anyone who reset
    // their password could never sign in again.
    const block = buildBlock({ options: { emailAndPassword: { password: { hash: undefined } } } });

    expect(typeof block.password.hash).toBe('function');
    expect(typeof block.password.verify).toBe('function');
  });

  it('lets a consumer callback replace the framework hook — the documented consequence', () => {
    // The README warns against configuring sendResetPassword under `options`; this pins WHAT
    // happens if you do, so the warning stays accurate. The consumer's callback wins, which means
    // the mail no longer goes through sendPasswordResetEmail() or the framework templates — and it
    // loses the fire-and-forget wrapper that keeps response time from revealing address existence.
    const consumerCallback = async () => undefined;
    const block = buildBlock({ options: { emailAndPassword: { sendResetPassword: consumerCallback } } });

    expect(block.sendResetPassword).toBe(consumerCallback);
    expect(typeof block.password?.hash).toBe('function');
  });
});
