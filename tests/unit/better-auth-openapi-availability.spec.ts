import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { admin, openAPI, organization, twoFactor } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';

import {
  isUnavailableOperation,
  unavailableBetterAuthOperations,
} from '../../src/core/modules/better-auth/core-better-auth-openapi.helper';
import { CoreBetterAuthService } from '../../src/core/modules/better-auth/core-better-auth.service';

import type { IBetterAuthRuntime } from '../../src/core/modules/better-auth/core-better-auth-openapi.helper';

/**
 * Better-Auth's OpenAPI generator lists every registered endpoint, including those its own request-time
 * checks refuse for every caller under the running options. `unavailableBetterAuthOperations()` removes
 * them, so the Swagger document lists only what can succeed. Each rule mirrors one of those checks; the
 * contract cases below fail when an upgrade of better-auth moves one, so the table cannot go stale
 * silently.
 */

/** Everything switched on that a rule reads — the baseline under which nothing is unavailable. */
function allOn(): IBetterAuthRuntime {
  return {
    options: {
      emailAndPassword: { enabled: true, sendResetPassword: () => undefined },
      emailVerification: { sendVerificationEmail: () => undefined },
      plugins: [{ id: 'two-factor', options: { otpOptions: { sendOTP: () => undefined } } }],
      session: { additionalFields: { device: {} }, deferSessionRefresh: true },
      user: { changeEmail: { enabled: true }, deleteUser: { enabled: true } },
    },
    socialProviders: [{ id: 'github' }],
  };
}

function unavailableWith(change: (runtime: IBetterAuthRuntime) => void): Set<string> {
  const runtime = allOn();
  change(runtime);
  return unavailableBetterAuthOperations(runtime);
}

describe('unavailableBetterAuthOperations', () => {
  it('finds nothing unavailable when every option a rule reads is on', () => {
    expect([...unavailableWith(() => undefined)]).toEqual([]);
  });

  it.each([
    ['POST /get-session without deferSessionRefresh', (r: IBetterAuthRuntime) => (r.options!.session!.deferSessionRefresh = false), ['post /get-session']],
    [
      'social routes without a provider',
      (r: IBetterAuthRuntime) => (r.socialProviders = []),
      ['/sign-in/social', '/callback/{id}', '/link-social', '/refresh-token', '/get-access-token', '/account-info', '/unlink-account'],
    ],
    [
      'social routes without a provider, unlinking all allowed',
      (r: IBetterAuthRuntime) => {
        r.socialProviders = [];
        r.options!.account = { accountLinking: { allowUnlinkingAll: true } };
      },
      ['/sign-in/social', '/callback/{id}', '/link-social', '/refresh-token', '/get-access-token', '/account-info'],
    ],
    [
      'verification routes without sendVerificationEmail',
      (r: IBetterAuthRuntime) => delete r.options!.emailVerification,
      ['/send-verification-email', '/verify-email'],
    ],
    [
      'reset routes without sendResetPassword',
      (r: IBetterAuthRuntime) => delete r.options!.emailAndPassword!.sendResetPassword,
      ['/request-password-reset', '/reset-password', '/reset-password/{token}'],
    ],
    [
      'email/password routes when it is disabled',
      (r: IBetterAuthRuntime) => (r.options!.emailAndPassword!.enabled = false),
      // Better-Auth checks `enabled` on sign-in and sign-up only; change/verify password keep working.
      ['/sign-in/email', '/sign-up/email'],
    ],
    [
      'update-session without a session field that accepts input',
      (r: IBetterAuthRuntime) => (r.options!.session!.additionalFields = { device: { input: false } }),
      ['/update-session'],
    ],
    [
      'unlink-account without a provider unless unlinking all is allowed',
      (r: IBetterAuthRuntime) => (r.socialProviders = []),
      ['/sign-in/social', '/callback/{id}', '/link-social', '/refresh-token', '/get-access-token', '/account-info', '/unlink-account'],
    ],
    ['sign-up when disabled', (r: IBetterAuthRuntime) => (r.options!.emailAndPassword!.disableSignUp = true), ['/sign-up/email']],
    ['delete-user when not enabled', (r: IBetterAuthRuntime) => delete r.options!.user!.deleteUser, ['/delete-user', '/delete-user/callback']],
    ['change-email when not enabled', (r: IBetterAuthRuntime) => delete r.options!.user!.changeEmail, ['/change-email']],
    [
      'two-factor OTP without sendOTP',
      (r: IBetterAuthRuntime) => (r.options!.plugins = [{ id: 'two-factor', options: {} }]),
      ['/two-factor/send-otp', '/two-factor/verify-otp'],
    ],
    [
      'two-factor TOTP when disabled',
      (r: IBetterAuthRuntime) =>
        (r.options!.plugins = [
          { id: 'two-factor', options: { otpOptions: { sendOTP: () => undefined }, totpOptions: { disable: true } } },
        ]),
      ['/two-factor/get-totp-uri', '/two-factor/verify-totp'],
    ],
  ])('marks %s', (_label, change, expected) => {
    expect([...unavailableWith(change as (r: IBetterAuthRuntime) => void)].sort()).toEqual([...expected].sort());
  });

  it('applies a method-specific entry to that method only', () => {
    const unavailable = unavailableWith((r) => delete r.options!.session);
    expect(isUnavailableOperation(unavailable, 'POST', '/get-session')).toBe(true);
    expect(isUnavailableOperation(unavailable, 'get', '/get-session')).toBe(false);
  });

  it('applies no two-factor rule when the plugin is not registered', () => {
    const unavailable = unavailableWith((r) => (r.options!.plugins = []));
    expect([...unavailable].some((key) => key.includes('two-factor'))).toBe(false);
  });

  it('reads a live instance: the generator lists what the rules remove', async () => {
    const auth = betterAuth({
      basePath: '/iam',
      baseURL: 'http://localhost:3000',
      database: memoryAdapter({}),
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
      plugins: [twoFactor({ issuer: 'Availability spec' }), openAPI({ disableDefaultReference: true })],
      secret: 'availability-spec-secret-7c1e9a54b2f04d38a6e1',
    });
    const schema = (await auth.api.generateOpenAPISchema()) as unknown as { paths: Record<string, object> };
    // Listed by the generator although every caller gets an error under these options — the reason the
    // rules exist.
    expect(Object.keys(schema.paths['/get-session'])).toContain('post');
    expect(schema.paths['/two-factor/send-otp']).toBeDefined();
    expect(schema.paths['/sign-in/social']).toBeDefined();

    const unavailable = unavailableBetterAuthOperations((await auth.$context) as unknown as IBetterAuthRuntime);
    expect(isUnavailableOperation(unavailable, 'post', '/get-session')).toBe(true);
    expect(isUnavailableOperation(unavailable, 'post', '/two-factor/send-otp')).toBe(true);
    expect(isUnavailableOperation(unavailable, 'post', '/sign-in/social')).toBe(true);
    expect(isUnavailableOperation(unavailable, 'post', '/two-factor/enable')).toBe(false);
    expect(isUnavailableOperation(unavailable, 'post', '/sign-in/email')).toBe(false);
  });
});

describe('contract: the checks the rules mirror still exist in better-auth', () => {
  // Resolved from the workspace root, like password-reset-paths-contract.spec.ts.
  const dist = resolve(process.cwd(), 'node_modules/better-auth/dist');
  const source = (file: string) => readFileSync(resolve(dist, file), 'utf8');

  it.each([
    ['api/routes/session.mjs', ['deferSessionRefresh', 'METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED']],
    ['api/routes/sign-in.mjs', ['PROVIDER_NOT_FOUND', 'EMAIL_PASSWORD_DISABLED']],
    ['api/routes/callback.mjs', ['PROVIDER_NOT_FOUND']],
    ['api/routes/account.mjs', ['socialProviders', 'is not supported', 'allowUnlinkingAll']],
    ['api/routes/update-session.mjs', ['No fields to update']],
    ['api/routes/email-verification.mjs', ['emailVerification?.sendVerificationEmail']],
    ['api/routes/password.mjs', ['emailAndPassword?.sendResetPassword', 'RESET_PASSWORD_DISABLED']],
    ['api/routes/sign-up.mjs', ['emailAndPassword?.disableSignUp']],
    ['api/routes/update-user.mjs', ['deleteUser?.enabled', 'CHANGE_EMAIL_DISABLED']],
    ['plugins/two-factor/index.mjs', ['otpOptions?.sendOTP', 'OTP_NOT_CONFIGURED', 'TOTP_NOT_CONFIGURED']],
    // HANDLER_SESSION_PATHS: the social-account routes check the session in their handler.
    [
      'api/routes/account.mjs',
      ['async function resolveUserId', 'if (!session && (ctx.request || ctx.headers)) throw ctx.error("UNAUTHORIZED")'],
    ],
  ])('%s', (file, markers) => {
    const text = source(file);
    for (const marker of markers) {
      expect(text, `${file} no longer contains ${marker} — re-check unavailableBetterAuthOperations()`).toContain(
        marker,
      );
    }
  });
});

describe('which Better-Auth routes need a session', () => {
  /** The service's decision for a given `auth.api`, without booting the module. */
  const guardedOf = (api: unknown, instance?: unknown): Set<string> | undefined =>
    (CoreBetterAuthService.prototype as any).sessionGuardedOperations.call({
      getApi: () => api,
      getInstance: () => instance,
      logger: { warn: () => undefined },
    });

  it("reads Better-Auth's session middleware, and the social routes that check in their handler", () => {
    const auth = betterAuth({
      basePath: '/iam',
      baseURL: 'http://localhost:3000',
      database: memoryAdapter({}),
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
      plugins: [twoFactor({ issuer: 'Session spec' })],
      secret: 'session-guard-spec-secret-7c41d9e2b8a5',
      socialProviders: { github: { clientId: 'id', clientSecret: 'secret' } },
    });
    const guarded = guardedOf(auth.api);
    for (const operation of [
      'get /list-sessions',
      'post /change-password',
      'post /two-factor/enable',
      'get /account-info',
      'post /get-access-token',
    ]) {
      expect(guarded?.has(operation), operation).toBe(true);
    }
    for (const operation of [
      'post /sign-in/email',
      'post /request-password-reset',
      'get /get-session',
      'get /reset-password/{token}',
      'post /two-factor/verify-totp',
    ]) {
      expect(guarded?.has(operation), operation).toBe(false);
    }
  });

  /**
   * @regression   11.42.9 (pre-release review) — routes of plugins a project adds were classified by the
   *   session middleware of Better-Auth's core only; `admin()` checks the session in a middleware of its
   *   own and `organization()` nests it, so `/admin/ban-user` or `/admin/impersonate-user` were documented
   *   as public and generated clients called them without credentials.
   * @seen-failing Classify foreign plugin routes like core routes again in
   *   CoreBetterAuthService.sessionGuardedOperations() (src/core/modules/better-auth/core-better-auth.service.ts)
   *   — registered as mutation `better-auth-plugin-routes-public` in tests/regression-mutations.json.
   */
  it("keeps the global requirement on routes of plugins nest-server does not register itself", () => {
    const auth = betterAuth({
      basePath: '/iam',
      baseURL: 'http://localhost:3000',
      database: memoryAdapter({}),
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
      plugins: [twoFactor({ issuer: 'Session spec' }), admin(), organization()],
      secret: 'session-guard-spec-secret-7c41d9e2b8a5',
    });
    const guarded = guardedOf(auth.api, auth);
    for (const operation of [
      'post /admin/ban-user',
      'post /admin/impersonate-user',
      'get /admin/list-users',
      'post /organization/create',
      'get /organization/list',
    ]) {
      expect(guarded?.has(operation), operation).toBe(true);
    }
    // The built-in plugins are still classified by their middleware.
    expect(guarded?.has('post /two-factor/verify-totp')).toBe(false);
    expect(guarded?.has('post /two-factor/enable')).toBe(true);
  });

  it('documents every route as authenticated when the instance uses none of the imported middlewares', () => {
    expect(guardedOf({ other: { options: { method: 'GET', use: [() => undefined] }, path: '/other' } })).toBeUndefined();
  });
});
