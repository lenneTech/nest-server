/**
 * Dependency-injection tokens of the better-auth module.
 *
 * These live in a dedicated file — instead of core-better-auth.module.ts /
 * core-better-auth.service.ts — so that module and service never have to import
 * each other. The tokens used to be split across both files
 * (BETTER_AUTH_INSTANCE in the module, BETTER_AUTH_CONFIG /
 * BETTER_AUTH_COOKIE_DOMAIN in the service), which made the two files import
 * each other in a cycle. That cycle happened to work under tsc/CommonJS by
 * evaluation-order luck, but crashed SWC-compiled builds (`nest start -b swc`)
 * with a temporal-dead-zone error:
 *
 *   ReferenceError: Cannot access 'BETTER_AUTH_INSTANCE' before initialization
 *
 * Keeping the tokens in a leaf module with no imports of its own makes the
 * dependency graph acyclic and the initialization order deterministic for every
 * compiler.
 */

/**
 * Token for injecting the better-auth instance
 */
export const BETTER_AUTH_INSTANCE = 'BETTER_AUTH_INSTANCE';

/**
 * Injection token for resolved BetterAuth configuration
 */
export const BETTER_AUTH_CONFIG = 'BETTER_AUTH_CONFIG';

/**
 * Injection token for resolved cross-subdomain cookie domain.
 * Set during Better-Auth instance creation, undefined if disabled.
 */
export const BETTER_AUTH_COOKIE_DOMAIN = 'BETTER_AUTH_COOKIE_DOMAIN';
