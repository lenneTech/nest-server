import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { createBetterAuthInstance } from '../../src/core/modules/better-auth/better-auth.config';

/**
 * Where the browser lands when an OAuth flow fails without an error URL of its own.
 *
 * Better-Auth sends a failed OAuth callback to the flow's `errorCallbackURL`, which travels inside the state. When the
 * state cannot be read (expired after ten minutes on the provider's sign-in page, missing, tampered) or the flow was
 * started without one, it falls back to `onAPIError.errorURL`, and without that to its own `<baseUrl>/iam/error`: an
 * English HTML page on the API host, with no way back into the app. Measured against Microsoft Entra ID with a user who
 * took longer than ten minutes to sign in.
 *
 * Since 12.9.5 nest-server derives `onAPIError.errorURL` from `betterAuth.errorUrl`, by default `<appUrl>/auth/login`.
 * The cases build the REAL `createBetterAuthInstance()` and read what Better-Auth holds; two run Better-Auth's own
 * handler.
 */

/** Minimal MongoDB `Db` stand-in: lookups find nothing, writes succeed. */
const fakeDb: any = {
  collection: () => ({
    aggregate: () => ({ toArray: async () => [] }),
    createIndex: async () => undefined,
    find: () => {
      const cursor: any = { limit: () => cursor, skip: () => cursor, sort: () => cursor, toArray: async () => [] };
      return cursor;
    },
    findOne: async () => null,
    insertOne: async () => ({ insertedId: 'x' }),
  }),
};

const VALID_SECRET = 'a-very-long-secret-that-is-at-least-32-characters-long-for-testing';
const API = 'https://api.example.com';
const APP = 'https://app.example.com';

interface Server {
  appUrl?: string;
  baseUrl?: string;
  cors?: Record<string, unknown>;
  env?: string;
}

/** The Better-Auth instance for a `betterAuth` configuration on a server with the given URLs (defaults: API + app). */
function instanceFor(config: Record<string, unknown> = {}, server: Server = { appUrl: APP, baseUrl: API }): any {
  const result = createBetterAuthInstance({
    config: { enabled: true, secret: VALID_SECRET, ...config } as any,
    db: fakeDb,
    serverAppUrl: server.appUrl,
    serverBaseUrl: server.baseUrl,
    serverCorsConfig: server.cors as any,
    serverEnv: server.env ?? 'test',
  } as any);
  expect(result).not.toBeNull();
  return result!.instance;
}

/** What Better-Auth holds as `onAPIError` */
async function onApiError(config: Record<string, unknown> = {}, server?: Server): Promise<Record<string, any>> {
  const context = await instanceFor(config, server).$context;
  return context.options.onAPIError ?? {};
}

/** Collects the warnings of the config module (the Nest logger prints errors only in this suite) */
function captureWarnings(): string[] {
  const messages: string[] = [];
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(((message: unknown) => {
    messages.push(String(message));
  }) as never);
  return messages;
}

describe('Better-Auth error URL (onAPIError.errorURL)', () => {
  describe('derived default', () => {
    it("is the app's login page when the app URL is configured", async () => {
      expect((await onApiError()).errorURL).toBe(`${APP}/auth/login`);
    });

    it('follows the app URL derived from the API base URL', async () => {
      expect((await onApiError({}, { baseUrl: API })).errorURL).toBe('https://example.com/auth/login');
    });

    it('uses the localhost app default in a local environment', async () => {
      expect((await onApiError({}, { env: 'local' })).errorURL).toBe('http://localhost:3001/auth/login');
    });

    it("keeps Better-Auth's own page when no app URL resolves", async () => {
      expect((await onApiError({}, {})).errorURL).toBeUndefined();
    });

    it("keeps Better-Auth's own page when cors.deriveAppUrl: false forbids deriving the app URL", async () => {
      expect((await onApiError({}, { baseUrl: API, cors: { deriveAppUrl: false } })).errorURL).toBeUndefined();
    });
  });

  describe('betterAuth.errorUrl', () => {
    it('uses an absolute http(s) URL as it is', async () => {
      expect((await onApiError({ errorUrl: 'https://login.example.com/oops?from=iam' })).errorURL).toBe(
        'https://login.example.com/oops?from=iam',
      );
    });

    it('resolves a path against the app URL', async () => {
      expect((await onApiError({ errorUrl: '/sign-in' })).errorURL).toBe(`${APP}/sign-in`);
    });

    it("keeps Better-Auth's own page for a path when no app URL resolves, with one warning", async () => {
      const warnings = captureWarnings();
      expect((await onApiError({ errorUrl: '/sign-in' }, {})).errorURL).toBeUndefined();
      const own = warnings.filter((message) => message.includes('errorUrl'));
      expect(own).toHaveLength(1);
      expect(own[0]).toContain('/sign-in');
    });

    it("keeps Better-Auth's own page for false", async () => {
      const warnings = captureWarnings();
      expect((await onApiError({ errorUrl: false })).errorURL).toBeUndefined();
      expect(warnings.filter((message) => message.includes('errorUrl'))).toHaveLength(0);
    });

    it.each([
      ['a protocol-relative URL', '//evil.example/login'],
      ['a path with a backslash after the slash', '/\\evil.example/login'],
      ['another scheme', 'javascript:alert(1)'],
      ['an ftp URL', 'ftp://example.com/login'],
      ['a bare word', 'login'],
      ['an empty string', ''],
      ['a number (an empty NSC__ variable)', 0],
      ['an object', { url: '/login' }],
    ])("refuses %s with one warning and keeps Better-Auth's own page", async (_form, errorUrl) => {
      const warnings = captureWarnings();
      expect((await onApiError({ errorUrl })).errorURL).toBeUndefined();
      expect(warnings.filter((message) => message.includes('errorUrl'))).toHaveLength(1);
    });
  });

  describe('betterAuth.options.onAPIError', () => {
    it('lets an explicit options.onAPIError.errorURL win over everything', async () => {
      expect(
        (
          await onApiError({
            errorUrl: '/sign-in',
            options: { onAPIError: { errorURL: 'https://errors.example.com/' } },
          })
        ).errorURL,
      ).toBe('https://errors.example.com/');
    });

    it('keeps the derived errorURL when options.onAPIError sets other keys only', async () => {
      const onError = () => undefined;
      const merged = await onApiError({
        options: { onAPIError: { customizeDefaultErrorPage: {}, onError, throw: false } },
      });
      expect(merged.errorURL).toBe(`${APP}/auth/login`);
      expect(merged.onError).toBe(onError);
      expect(merged.throw).toBe(false);
      expect(merged.customizeDefaultErrorPage).toEqual({});
    });
  });

  describe("Better-Auth's own handler", () => {
    /**
     * @regression   12.9.5 — an OAuth callback that failed without an error URL of its own (state expired after ten
     *   minutes, missing or tampered; a flow started without `errorCallbackURL`) sent the browser to Better-Auth's
     *   built-in error page on the API host: no way back into the app, no sign-in button.
     * @seen-failing Remove the `onAPIError` buildBetterAuthOptions() sets
     *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
     *   `iam-oauth-error-url-not-derived` in tests/regression-mutations.json.
     */
    it("sends a callback without a readable state to the app's login page", async () => {
      const response: Response = await instanceFor().handler(new Request(`${API}/iam/callback/microsoft`));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`${APP}/auth/login?error=state_not_found`);
    });

    /**
     * @regression   12.9.5 — written together with the default: a project that sets `options.onAPIError` for another
     *   reason (`onError`, `throw`) replaced the whole object, so its failed callbacks landed on the API's error page
     *   again.
     * @seen-failing Let `options.onAPIError` replace the framework's object in buildBetterAuthOptions()
     *   (src/core/modules/better-auth/better-auth.config.ts) — registered as mutation
     *   `iam-oauth-error-url-options-replace` in tests/regression-mutations.json.
     */
    it('keeps the login page when the project sets options.onAPIError for another reason', async () => {
      const instance = instanceFor({ options: { onAPIError: { onError: () => undefined } } });
      const response: Response = await instance.handler(new Request(`${API}/iam/callback/microsoft`));
      expect(response.headers.get('location')).toBe(`${APP}/auth/login?error=state_not_found`);
    });

    it("forwards Better-Auth's own error page to the app's login page", async () => {
      const response: Response = await instanceFor().handler(
        new Request(`${API}/iam/error?error=state_mismatch&error_description=Try%20again`),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        `${APP}/auth/login?error=state_mismatch&error_description=Try+again`,
      );
    });
  });
});
