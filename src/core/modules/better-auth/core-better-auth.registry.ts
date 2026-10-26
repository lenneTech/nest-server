/**
 * Runtime registry for better-auth singletons that must be reachable from files
 * which cannot import core-better-auth.module.ts.
 *
 * `BetterAuthRolesGuard` deliberately has no constructor dependencies (see
 * .claude/rules/better-auth.md §5), so it cannot receive `BetterAuthTokenService`
 * through DI and has to look it up statically. Reading it from
 * `CoreBetterAuthModule` would make guard and module import each other — the same
 * cycle shape that crashed SWC builds when the DI tokens still lived in the module
 * and the service (see core-better-auth.constants.ts).
 *
 * This file therefore holds the reference instead. It uses only `import type`,
 * which both tsc and SWC erase entirely, so it emits no `require()` at all and is
 * a true leaf: it can never be mid-evaluation when someone imports it, in any
 * module system, under any compiler.
 *
 * @internal Populated by CoreBetterAuthModule.onModuleInit(). Read it through the
 * public `CoreBetterAuthModule.getTokenServiceInstance()` unless you are in a file
 * that the module itself imports — importing the module from there would re-create
 * the cycle.
 */

import type { BetterAuthTokenService } from './better-auth-token.service.js';

let tokenServiceInstance: BetterAuthTokenService | null = null;

/**
 * Stores the BetterAuthTokenService singleton.
 * Called by CoreBetterAuthModule during module initialization.
 * @internal
 */
export function setBetterAuthTokenService(service: BetterAuthTokenService | null): void {
  tokenServiceInstance = service;
}

/**
 * Returns the BetterAuthTokenService singleton, or null when better-auth is
 * disabled or the module has not initialized yet.
 *
 * Safe to call from guards: they run only after module initialization.
 */
export function getBetterAuthTokenService(): BetterAuthTokenService | null {
  return tokenServiceInstance;
}

/**
 * Clears the registry. Called by CoreBetterAuthModule.reset() so tests do not
 * leak a token service from a previous testing module into the next one.
 * @internal
 */
export function resetBetterAuthRegistry(): void {
  tokenServiceInstance = null;
}

/** A class decorated as an IAM controller or resolver; subclasses in projects count as the same handler. */
type BetterAuthHandlerClass = abstract new (...args: any[]) => unknown;

const handlerClasses = new Set<BetterAuthHandlerClass>();

/**
 * Records `CoreBetterAuthController` / `CoreBetterAuthResolver`, called once by each file as it is loaded.
 *
 * `CoreTenantGuard` skips the tenant check for IAM handlers and has to recognise them without importing them —
 * tenant and better-auth reach each other. It used a lazy `require()` of both files for that, which exists only
 * in CommonJS; this registry is the form that works in both module systems. Not cleared by
 * `resetBetterAuthRegistry()`: the classes are registered when their file loads, which happens once per process.
 * @internal
 */
export function registerBetterAuthHandlerClass(handlerClass: BetterAuthHandlerClass): void {
  handlerClasses.add(handlerClass);
}

/**
 * Whether `handlerClass` is one of the registered IAM handler classes or extends one.
 * @internal
 */
export function isBetterAuthHandlerClass(handlerClass: Function | undefined): boolean {
  if (!handlerClass) {
    return false;
  }
  for (const base of handlerClasses) {
    if (handlerClass === base || handlerClass.prototype instanceof base) {
      return true;
    }
  }
  return false;
}
