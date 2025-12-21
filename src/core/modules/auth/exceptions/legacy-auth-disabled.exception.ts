import { GoneException } from '@nestjs/common';

/**
 * Exception thrown when Legacy Auth endpoints are accessed but disabled
 *
 * This exception is thrown when:
 * - config.auth.legacyEndpoints.enabled is false
 * - config.auth.legacyEndpoints.graphql is false (for GraphQL endpoints)
 * - config.auth.legacyEndpoints.rest is false (for REST endpoints)
 *
 * HTTP Status: 410 Gone
 *
 * This status code indicates that the resource is no longer available
 * and will not be available again - appropriate for deprecated endpoints.
 *
 * @since 11.7.1
 *
 * @example
 * ```typescript
 * if (!this.isLegacyEndpointEnabled()) {
 *   throw new LegacyAuthDisabledException();
 * }
 * ```
 */
export class LegacyAuthDisabledException extends GoneException {
  constructor(endpoint?: string) {
    super({
      error: 'Legacy Auth Disabled',
      message: endpoint
        ? `Legacy Auth endpoint '${endpoint}' is disabled. Use BetterAuth (IAM) endpoints instead.`
        : 'Legacy Auth endpoints are disabled. Use BetterAuth (IAM) endpoints instead.',
      statusCode: 410,
    });
  }
}
