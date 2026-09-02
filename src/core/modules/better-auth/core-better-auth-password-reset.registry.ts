/**
 * Carries the password of an in-flight IAM password reset from the API middleware
 * to Better-Auth's `onPasswordReset` hook.
 *
 * WHY THIS EXISTS
 *
 * A reset has to land in BOTH credential stores when Legacy Auth and IAM run next to
 * each other: IAM keeps scrypt, Legacy keeps bcrypt, and neither hash can be derived
 * from the other. Mirroring a reset into the legacy store therefore needs the password
 * itself — and the two halves are known in two different places:
 *
 * | half | known by |
 * |------|----------|
 * | the new password | `CoreBetterAuthApiMiddleware`, which sees the request body |
 * | which user it belongs to | `emailAndPassword.onPasswordReset`, which Better-Auth calls with the user |
 *
 * Better-Auth hands its hook `{ user }` and the original `Request`, whose body is
 * already consumed by then, so the hook cannot recover the password on its own. The
 * alternative — resolving the user in the middleware by parsing Better-Auth's
 * `reset-password:<token>` verification identifier — would couple us to an internal
 * storage format that no contract keeps stable. Using the supported hook for the user
 * and this registry for the password keeps the only coupling inside our own code.
 *
 * The value stored here is ALREADY NORMALIZED (`normalizePasswordForIam`), i.e. exactly
 * what Better-Auth hashed, so the legacy mirror cannot drift from the IAM credential
 * even when the client posts a plaintext password.
 *
 * A true leaf: it imports nothing but a Node built-in, so it can never be
 * mid-evaluation when a cycle-adjacent file reads it (see
 * `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)").
 *
 * @internal Not public API — but NOT optional. Two shipped core files import it
 * (`core-better-auth-api.middleware.ts`, `core-better-auth.module.ts`), so a vendor-mode sync that
 * skips this file leaves an unresolvable import. `@internal` means "do not depend on this from a
 * project", never "you may leave it out".
 */

import { AsyncLocalStorage } from 'async_hooks';

interface PasswordResetContext {
  /**
   * The new password as Better-Auth will hash it — already normalized.
   *
   * Cleared on the first read (see {@link getInFlightResetPassword}), so the property is
   * optional after that point.
   */
  normalizedPassword?: string;
}

const storage = new AsyncLocalStorage<PasswordResetContext>();

/**
 * Runs `fn` with the in-flight reset password attached to the async context.
 *
 * Wrap ONLY the Better-Auth handler call: the context has to be alive while
 * `onPasswordReset` runs, and dead everywhere else, so an unrelated request can never
 * pick up a password that was not its own.
 *
 * @internal
 */
export function runWithResetPassword<T>(normalizedPassword: string, fn: () => T): T {
  return storage.run({ normalizedPassword }, fn);
}

/**
 * The normalized password of the reset currently being handled, or `undefined`
 * outside such a request.
 *
 * `undefined` means "not a reset we saw the body of" — never "no password". Callers
 * must skip the mirror rather than guess, because writing a wrong bcrypt hash would
 * lock the account out of the legacy path.
 *
 * @internal
 */
export function getInFlightResetPassword(): string | undefined {
  const store = storage.getStore();
  if (!store) {
    return undefined;
  }

  // ONE-SHOT. The legacy mirror is the only legitimate reader and it reads once, so handing the
  // value out a second time can only serve something that should not have it.
  //
  // Defence in depth rather than a fix for a known hole: an AsyncLocalStorage store is retained
  // by any async resource created INSIDE the `run()` that outlives it — a timer registered during
  // lazy plugin init, a cached promise. Such a resource would otherwise keep observing a
  // password-equivalent from a request that finished long ago. Clearing on read bounds that to
  // the moment the mirror actually runs.
  const { normalizedPassword } = store;
  store.normalizedPassword = undefined;
  return normalizedPassword;
}
