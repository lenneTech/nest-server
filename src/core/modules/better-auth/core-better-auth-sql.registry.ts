/**
 * The SQL store of Better-Auth's data while Better-Auth runs on a SQL source — `undefined` on MongoDB. Set by
 * `CoreBetterAuthModule` when it creates the instance (every creation sets it, so an application on MongoDB booted
 * after one on SQL in the same process reads `undefined`), read by the user mapper, the token and challenge services,
 * the system setup and the API token service at call time.
 *
 * `import type` only — an import-free leaf, so none of those files imports the module (see
 * `.claude/rules/better-auth.md` §6).
 */
import type { BetterAuthSqlStore } from './core-better-auth-sql.store.js';

let store: BetterAuthSqlStore | undefined;

export function setBetterAuthSqlStore(value: BetterAuthSqlStore | undefined): void {
  store = value;
}

export function getBetterAuthSqlStore(): BetterAuthSqlStore | undefined {
  return store;
}
