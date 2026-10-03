import * as betterAuthCoreDb from '@better-auth/core/db';

/**
 * The synthetic issuer better-auth 1.7.0–1.7.2 stores on credential accounts — or `undefined` when
 * the installed better-auth no longer uses one.
 *
 * better-auth 1.7.0 keyed accounts by `(issuer, accountId)` and exported `createLocalAccountIssuer`
 * to derive the credential issuer. 1.7.3 restored the 1.6 schema — accounts keyed by
 * `(providerId, accountId)` — and removed both. This framework works with either line: its peer
 * range starts at 1.7.7, but a project that has not raised its pin yet must keep signing users in.
 * So every place that writes or repairs an account asks THIS function instead of importing the
 * helper: a static import does not even compile against 1.7.3+, and an issuer written there would
 * be dead data.
 *
 * Resolved at call time from the module namespace, never cached at load, so a test can swap it.
 */
export function legacyCredentialAccountIssuer(): string | undefined {
  const create = (betterAuthCoreDb as unknown as Record<string, unknown>).createLocalAccountIssuer;
  return typeof create === 'function' ? (create as (providerId: string) => string)('credential') : undefined;
}

/** Whether the installed better-auth keys accounts by `(issuer, accountId)` — 1.7.0 to 1.7.2. */
export function usesLegacyAccountIssuer(): boolean {
  return legacyCredentialAccountIssuer() !== undefined;
}
