import { SetMetadata } from '@nestjs/common';

import { API_TOKEN_SCOPES_KEY } from './core-api-token.constants';

/**
 * Method/class decorator that opens an endpoint to API tokens (`apiTokens` config).
 *
 * Tokens are DENIED on every route by default — user tokens and tenant tokens alike. A route accepts
 * one only when it names the scopes that may call it; a token holding ANY one of them passes. A
 * method-level declaration replaces the class-level one rather than adding to it, so a class can open
 * itself for `'read'` while a single method narrows to `'export'`.
 *
 * Opening a route does not widen what a token may do there, it only stops the blanket refusal:
 * - a USER token then acts as its user (without global roles), bounded by the token's own limits;
 * - a TENANT token acts as a member of its tenant with the LOWEST role of the hierarchy, and
 *   `S_EVERYONE` / `S_USER` / `S_VERIFIED` count as satisfied for it.
 *
 * @example
 * ```typescript
 * @ApiTokenScopes('upload')
 * @Roles(RoleEnum.S_USER)
 * @Post('documents')
 * async upload(@CurrentUser() caller: any) {
 *   const token = getApiTokenContext(caller); // undefined for a session, set for a token
 * }
 * ```
 */
export const ApiTokenScopes = (scope: string, ...moreScopes: string[]) =>
  SetMetadata(API_TOKEN_SCOPES_KEY, [scope, ...moreScopes]);
