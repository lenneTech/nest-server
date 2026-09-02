import type { IAuthLegacyEndpoints } from '../../../common/interfaces/server-options.interface';

/**
 * The two transports legacy auth is reachable over.
 */
export type LegacyEndpointTransport = 'graphql' | 'rest';

/**
 * Decides whether the legacy auth endpoints are reachable over one transport.
 *
 * ONE resolver for both transports on purpose: the GraphQL resolver and the REST
 * controller each carried their own copy of this decision, and a rule about which auth
 * endpoints exist is exactly the kind of rule that must not be able to answer
 * differently depending on which door somebody knocks on.
 *
 * **Since 11.38.0 the default is OFF.** Legacy auth is superseded by IAM
 * (Better-Auth), which every project created from the starter has used for a while:
 * `CoreModule.forRoot(envConfig)` never registers the legacy module at all. What
 * changed is the answer for a project that DOES register it and never made a decision
 * about `legacyEndpoints` — previously it kept a second, fully functional
 * password-authentication surface open indefinitely, silently. A second way in that
 * nobody chose is a liability, so it now has to be asked for.
 *
 * Resolution order:
 *
 * | Configuration | Result |
 * |---------------|--------|
 * | `enabled: false` | off, whatever the per-transport flags say |
 * | per-transport flag set (`graphql` / `rest`) | that flag wins |
 * | `enabled: true` | on |
 * | nothing set | **off** (was: on, before 11.38.0) |
 *
 * `enabled: false` stays a hard off switch rather than something a per-transport `true`
 * can reopen: it is the setting a project reached for to close legacy down, and an
 * upgrade must never widen it.
 *
 * @param legacyConfig the `auth.legacyEndpoints` config block, if any
 * @param transport which transport is asking
 * @returns `true` when the legacy endpoints are reachable over that transport, `false` otherwise
 *
 * @example
 * ```typescript
 * // In a project that overrides the check on its own resolver
 * protected override checkLegacyGraphQLEnabled(endpointName: string): void {
 *   const legacyConfig = this.configService.getFastButReadOnly('auth')?.legacyEndpoints;
 *   if (!isLegacyEndpointEnabled(legacyConfig, 'graphql')) {
 *     throw new LegacyAuthDisabledException(endpointName);
 *   }
 * }
 * ```
 *
 * Call this rather than re-implementing the table: the two transports resolving the same rule
 * differently is the defect the shared function exists to prevent.
 */
export function isLegacyEndpointEnabled(
  legacyConfig: IAuthLegacyEndpoints | undefined,
  transport: LegacyEndpointTransport,
): boolean {
  if (legacyConfig?.enabled === false) {
    return false;
  }

  const perTransport = legacyConfig?.[transport];
  if (typeof perTransport === 'boolean') {
    return perTransport;
  }

  return legacyConfig?.enabled === true;
}
