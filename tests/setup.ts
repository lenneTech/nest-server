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
import { Logger } from '@nestjs/common';

const originalConsoleWarn = console.warn.bind(console);

console.warn = (...args: unknown[]): void => {
  if (typeof args[0] === 'string' && args[0].includes('[@UnifiedField] Deprecated long-form')) {
    return;
  }
  originalConsoleWarn(...args);
};

Logger.overrideLogger(['error', 'fatal']);
