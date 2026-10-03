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

/**
 * better-auth's default names for the account collection and for fields inside it.
 *
 * All are overridable by a consumer through `betterAuth.options.account.modelName` / `.fields.*`,
 * which `better-auth.config.ts` spreads onto the resolved config verbatim. Any framework code
 * touching that collection directly MUST resolve the real names from the running instance and fall
 * back to these — a hardcoded name silently addresses a collection or an index better-auth does not
 * use, and the operation then reports success by saying nothing.
 *
 * `issuer` is only used by better-auth 1.7.0–1.7.2; 1.7.3 restored the 1.6 schema (accounts keyed by
 * `(providerId, accountId)` again). Its name is still needed on both lines: for the backfill while a
 * project runs 1.7.0–1.7.2, and afterwards to recognise the unique index those versions left behind —
 * see `CoreBetterAuthService.dropLegacyAccountIssuerIndex()`.
 */
export const DEFAULT_ACCOUNT_MODEL_NAME = 'account';
export const DEFAULT_ACCOUNT_ISSUER_FIELD = 'issuer';
export const DEFAULT_ACCOUNT_ACCOUNT_ID_FIELD = 'accountId';

/**
 * Collection holding one-shot completion markers for boot-time data migrations, and the marker id
 * of the `account.issuer` backfill.
 *
 * The backfill only runs while the installed better-auth still keys accounts by issuer (1.7.0–1.7.2,
 * see `core-better-auth-account-issuer.helper.ts`). On 1.7.3+ the boot DELETES this marker instead:
 * should the project roll back to a better-auth that needs the issuer, the backfill then runs again
 * and repairs the accounts written in the meantime, rather than being skipped by a stale marker.
 *
 * The marker exists for cost, not for correctness: the backfill is idempotent and safe to repeat,
 * but its filters (`$exists: false`, `$ne`) cannot use an index, so without a marker every boot of
 * every replica pays a full pass over the account collection. Versioned in the id so a future
 * backfill of the same field can run again without clearing this one.
 */
export const BACKFILL_MARKER_COLLECTION = 'better-auth-backfills';
export const ACCOUNT_ISSUER_BACKFILL_ID = 'account-issuer-backfill-v1';
