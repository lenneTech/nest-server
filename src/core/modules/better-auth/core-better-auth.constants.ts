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
 * The lethal ingredient is not the cycle by itself — it is a cycle PLUS a read of
 * the cyclic binding at module-evaluation time. `@Inject(BETTER_AUTH_INSTANCE)` is
 * a constructor-parameter decorator, and decorator arguments are evaluated when the
 * class is defined, i.e. while the module is still initializing. On a cycle the
 * importing side then reads a `const` that has not been initialized yet.
 *
 * This file imports nothing, so it can never be mid-evaluation when someone
 * imports it — in any module system, under any compiler. That makes the
 * initialization order of the tokens deterministic everywhere.
 *
 * WHY THIS MATTERS FOR FUTURE CHANGES
 * -----------------------------------
 * `tsc` does NOT catch a regression here, and neither does the test suite: vitest
 * runs SWC through Vite's module runner, whose getter-based live bindings tolerate
 * cycles. Only the SWC → CommonJS → `require()` path fails, which is exactly what
 * `pnpm run check:swc-tdz` exercises. If you move a token back into the module or
 * the service, everything stays green locally and breaks for consumers.
 *
 * The rule, in short: **DI tokens belong in an import-free leaf file.**
 * See .claude/rules/better-auth.md §6.
 */

/**
 * Token for injecting the better-auth instance.
 *
 * Injected type: `BetterAuthInstance | null` — null when better-auth is disabled.
 * Declared `@Optional()` in the CoreBetterAuthService constructor.
 *
 * @example
 * ```typescript
 * import { Inject, Injectable, Optional } from '@nestjs/common';
 * import { BETTER_AUTH_INSTANCE, BetterAuthInstance } from '@lenne.tech/nest-server';
 *
 * @Injectable()
 * export class MyService {
 *   constructor(
 *     @Optional() @Inject(BETTER_AUTH_INSTANCE) private readonly auth: BetterAuthInstance | null,
 *   ) {}
 * }
 * ```
 */
export const BETTER_AUTH_INSTANCE = 'BETTER_AUTH_INSTANCE';

/**
 * Injection token for the resolved BetterAuth configuration.
 *
 * Injected type: `IBetterAuth | null` — null when better-auth is disabled.
 * Declared `@Optional()` in the CoreBetterAuthService constructor.
 */
export const BETTER_AUTH_CONFIG = 'BETTER_AUTH_CONFIG';

/**
 * Injection token for the resolved cross-subdomain cookie domain.
 * Set during Better-Auth instance creation, undefined if disabled.
 *
 * Injected type: `string | null | undefined`.
 * Declared `@Optional()` in the CoreBetterAuthService constructor.
 */
export const BETTER_AUTH_COOKIE_DOMAIN = 'BETTER_AUTH_COOKIE_DOMAIN';
