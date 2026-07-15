/**
 * Vitest setup file (runs in every test worker before the test files are imported).
 *
 * Reduces expected log noise so the test output stays readable. Two concerns:
 *
 * 1. `console.warn` filter — suppresses the intentional `[@UnifiedField] Deprecated long-form`
 *    deprecation warnings. Several tests verify backward compatibility of the deprecated
 *    long-form enum API (`tests/unified-field-enum*.e2e-spec.ts`) and therefore use
 *    `enum: { enum: X }` on purpose — many define the inputs at module level, so the warning
 *    is emitted at import time, before any `beforeEach` could intercept it. Only this exact
 *    framework message is filtered; every other `console.warn` is passed through unchanged.
 *    A direct assignment (not `vi.spyOn`) is used on purpose so a global `vi.restoreAllMocks()`
 *    never removes this filter.
 *
 * 2. NestJS `Logger` level — restricted to `error`/`fatal`. The framework emits expected
 *    `logger.warn`/`logger.log` output during tests (rate-limit-exceeded warnings from the
 *    rate-limiter services, Passkey auto-detection notices from BetterAuthConfig, Nest
 *    bootstrap logs). This is correct production behaviour but pure noise in test runs. Tests
 *    that assert a log call use `vi.spyOn(Logger, ...)`, which replaces the method outright and
 *    keeps working regardless of the configured level.
 */
/*
 * Per-worker database isolation (e2e).
 *
 * `global-setup.ts` gives each RUN one database (`…-run-<ts>-p<pid>`) via MONGODB_URI, and the e2e
 * config runs spec files in PARALLEL forks (`fileParallelism: true`). All those forks share that one
 * database — so a file that mutates a GLOBAL collection breaks every other file running at the same
 * time. The concrete flake: `better-auth-integration` clears the `jwks` collection (BetterAuth's JWT
 * signing keys, used implicitly by every BetterAuth instance) mid-run, which invalidates the tokens
 * of a parallel `better-auth-*` spec → its authenticated request gets a spurious 401.
 *
 * This runs in every fork BEFORE the test file (and therefore before `config.env.ts`) is imported,
 * so appending the vitest pool id to MONGODB_URI here gives each CONCURRENT fork its own database.
 * Files that share a fork run sequentially (safe); files in different forks can no longer collide.
 *
 * Cleanup is already handled: `db-lifecycle.reporter.ts` drops every DB whose name starts with the
 * run DB name (these are exactly `…-run-<ts>-p<pid>-w<N>`) on a passing run, and collects them as
 * stale on the next run otherwise. An externally pinned MONGODB_URI (CI service container) still gets
 * per-fork isolation; its mongod is ephemeral so the extra DBs are discarded with the container.
 */
if (process.env.MONGODB_URI && !/-w\d+(\?|$)/.test(process.env.MONGODB_URI)) {
  const poolId = process.env.VITEST_POOL_ID || process.env.VITEST_WORKER_ID || '0';
  // Insert the suffix before the query string (…/dbname?opts → …/dbname-wN?opts).
  process.env.MONGODB_URI = process.env.MONGODB_URI.replace(/(\/[^/?]+)(\?|$)/, `$1-w${poolId}$2`);
}

import { Logger } from '@nestjs/common';

const originalConsoleWarn = console.warn.bind(console);

console.warn = (...args: unknown[]): void => {
  if (typeof args[0] === 'string' && args[0].includes('[@UnifiedField] Deprecated long-form')) {
    return;
  }
  originalConsoleWarn(...args);
};

Logger.overrideLogger(['error', 'fatal']);
