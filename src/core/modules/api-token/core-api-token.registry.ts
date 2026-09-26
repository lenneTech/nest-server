/**
 * Lets the password-reset paths revoke a user's API tokens WITHOUT importing the optional token
 * module.
 *
 * Two places end a user's sessions on a reset — Better-Auth's `onPasswordReset` hook (IAM, when
 * `betterAuth.emailAndPassword.revokeSessionsOnPasswordReset` is on) and
 * `CoreUserService.resetPassword()` (legacy, always) — and a user token is a session in all but
 * lifetime: left alive, the credential a reset was meant to retire keeps working through it. Both
 * callers live in modules that load whether or not `apiTokens` is configured, so they reach the
 * service through this registry instead of DI: `CoreApiTokenService` fills it while it runs, and
 * without it every call is a no-op.
 *
 * A true leaf: no imports, so it can never be mid-evaluation when a cycle-adjacent file reads it
 * (see `.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)").
 *
 * @internal Not public API, but required by the shipped better-auth and user modules.
 */

/** Who a reset belongs to — any one field is enough; `userId` is the `users` document id. */
export interface ApiTokenOwnerIdentity {
  email?: string;
  iamId?: string;
  userId?: string;
}

type ApiTokenRevoker = (identity: ApiTokenOwnerIdentity) => Promise<number>;

let revoker: ApiTokenRevoker | undefined;

/**
 * Register (or, with `undefined`, clear) the function that revokes a user's tokens.
 * Returns a disposer that clears it again only if it is still the registered one.
 *
 * @internal
 */
export function setApiTokenRevoker(fn: ApiTokenRevoker | undefined): () => void {
  revoker = fn;
  return () => {
    if (revoker === fn) {
      revoker = undefined;
    }
  };
}

/**
 * Revoke every token of a user. Resolves to the number revoked — `0` when the token module is not
 * running, so callers never need to know whether it is.
 *
 * @internal
 */
export async function revokeApiTokensOfUser(identity: ApiTokenOwnerIdentity): Promise<number> {
  return revoker ? revoker(identity) : 0;
}
