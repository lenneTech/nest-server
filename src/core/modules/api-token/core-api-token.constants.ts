// Import-free leaf on purpose: guards of three modules (auth, better-auth, tenant) read these values,
// and a leaf can never be mid-evaluation when one of them imports it (see .claude/rules/architecture.md
// → "DI Token Placement (SWC-Safe)").

/**
 * Injection token / Mongoose model name for API tokens.
 */
export const API_TOKEN_MODEL_TOKEN = 'ApiToken';

/**
 * Metadata key for the `@ApiTokenScopes()` decorator.
 */
export const API_TOKEN_SCOPES_KEY = 'apiTokenScopes';

/**
 * Who an API token belongs to.
 *
 * - `USER`: owned by a user; acts with that user's CURRENT rights (never global roles such as ADMIN),
 *   optionally narrowed to scopes, one tenant and a maximum tenant role. Works with and without
 *   multi-tenancy.
 * - `TENANT`: owned by a tenant, independent of any person; managed by the tenant's administrators,
 *   acts with the lowest tenant role and only inside its own tenant. Requires multi-tenancy.
 */
export enum ApiTokenKind {
  TENANT = 'tenant',
  USER = 'user',
}
