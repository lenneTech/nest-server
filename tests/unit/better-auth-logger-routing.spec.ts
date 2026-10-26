/**
 * Better-Auth's runtime messages go through Nest's logger, not Better-Auth's own console logger.
 *
 * Better-Auth logs failed sign-ins ("Invalid password", "User not found") and refused CSRF attempts by
 * itself. Its default logger prints them straight to the console — no context, no respect for the
 * application's log levels or JSON mode, and in a test run a line for every negative-path case. Since
 * 12.0.0 the framework installs a `logger.log` handler that hands them to a Nest `Logger('BetterAuth')`.
 * Checked against the REAL constructed instance, because the routing lives in how the options are merged.
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';

const fakeDb: any = {
  collection: () => ({
    createIndex: async () => undefined,
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';

function loggerOption(options?: Record<string, unknown>): Record<string, any> {
  const result = createBetterAuthInstance({
    config: { enabled: true, secret: VALID_SECRET, ...(options ? { options } : {}) } as any,
    db: fakeDb,
  } as any);
  expect(result).not.toBeNull();
  return (result!.instance as any).options.logger as Record<string, any>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Better-Auth's logger", () => {
  it('hands each level to the matching Nest logger method', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { log } = loggerOption();

    log('warn', 'Invalid password');
    log('error', 'Blocked cross-site navigation login attempt', { origin: 'https://evil.example' });

    expect(warn).toHaveBeenCalledWith('Invalid password');
    expect(error).toHaveBeenCalledWith('Blocked cross-site navigation login attempt {"origin":"https://evil.example"}');
  });

  /**
   * @regression   12.0.0 — the routing serialized every argument with JSON.stringify, which turns an Error into `{}`.
   *   Better-Auth passes caught errors to its logger ("Failed to run background task:", e; "JWKS fetch failed:",
   *   error; `logger.error(e.name, e)` for an unexpected endpoint error), so the operator got "TypeError {}" where
   *   Better-Auth's own console logger had printed the message and the stack. A circular argument made the logger
   *   throw inside Better-Auth's error handling.
   * @seen-failing Drop the `instanceof Error` branch from formatBetterAuthLogArg() in
   *   src/core/modules/better-auth/better-auth.config.ts — registered as mutation `better-auth-log-error-args-dropped`
   *   in tests/regression-mutations.json.
   */
  it('keeps the message and stack of an Error argument, and survives a circular one', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { log } = loggerOption();

    log('error', 'Failed to run background task:', new Error('SMTP connection refused'));
    const circular: Record<string, unknown> = { provider: 'github' };
    circular.self = circular;
    expect(() => log('error', 'GitHub OAuth token exchange failed:', circular)).not.toThrow();

    const [backgroundLine] = error.mock.calls[0] as [string];
    expect(backgroundLine).toContain('Failed to run background task: Error: SMTP connection refused');
    expect(backgroundLine).toMatch(/\n\s+at /);
    const [circularLine] = error.mock.calls[1] as [string];
    expect(circularLine).toContain("provider: 'github'");
  });

  it("keeps the routing when a project only sets Better-Auth's level", () => {
    const logger = loggerOption({ logger: { level: 'debug' } });

    expect(logger.level).toBe('debug');
    expect(typeof logger.log).toBe('function');
  });

  it("lets a project's own log handler win", () => {
    const own = vi.fn();
    const logger = loggerOption({ logger: { log: own } });

    expect(logger.log).toBe(own);
  });
});
