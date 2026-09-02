/**
 * Where the password-reset mail sends the recipient.
 *
 * WHY THIS IS A DECISION AND NOT A DETAIL
 *
 * Better-Auth generates the link from its own base URL, which is the API
 * (`https://api.example.com/iam/reset-password/<token>?callbackURL=…`), and redirects from there
 * to the app. Functionally fine — but it puts a domain the recipient does not recognise into a
 * password mail, which is the one thing people are trained to check before clicking. In this stack
 * an app host and an API host are the norm, so 11.38.0 points at the app by default.
 *
 * WHAT THAT GIVES UP, AND WHAT IT DOES NOT
 *
 * Better-Auth's redirect route validates the token and its expiry before forwarding, so an expired
 * link produced an error page rather than a form that fails on submit. Pointing at the app moves
 * that error later. It is NOT a security difference — the token reaches the app URL either way,
 * and the `callbackURL` origin check exists only because of the hop it removes. `false` keeps the
 * old link for anyone who prefers the early error.
 *
 * The resolution order is the whole contract, so it is asserted row by row rather than described.
 *
 * @regression   11.38.0 — the reset mail linked to the API host, because Better-Auth's generated
 *   URL was passed through untouched.
 * @seen-failing Registered mutation `password-reset-link-ignores-config` in
 *   tests/regression-mutations.json — returns Better-Auth's URL unconditionally, i.e. restores the
 *   pass-through.
 */

import { describe, expect, it } from 'vitest';

import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';

const BETTER_AUTH_URL = 'https://api.example.com/iam/reset-password/tok-123?callbackURL=https%3A%2F%2Fexample.com';

/**
 * Reaches the protected resolver with a hand-built config, without constructing the whole service.
 *
 * The method is `protected` on purpose — a project may override it — so the test calls it the way
 * a subclass would rather than through a public surface that does not exist.
 */
const resolve = (options: { appUrl?: string; passwordResetLink?: false | string }): string => {
  const service = Object.create(CoreBetterAuthEmailVerificationService.prototype) as any;
  service.config = { passwordResetLink: options.passwordResetLink };
  service.configService = {
    getFastButReadOnly: (key: string) => (key === 'appUrl' ? options.appUrl : undefined),
  };

  return service.buildPasswordResetUrl({
    token: 'tok-123',
    url: BETTER_AUTH_URL,
    user: { email: 'someone@test.com', id: 'u1' },
  });
};

describe('password-reset link resolution', () => {
  it('points at the app by default', () => {
    // The unconfigured path — what a project gets by upgrading and doing nothing.
    expect(resolve({ appUrl: 'https://example.com' })).toBe('https://example.com/auth/reset-password?token=tok-123');
  });

  it('tolerates a trailing slash on the app URL', () => {
    expect(resolve({ appUrl: 'https://example.com/' })).toBe('https://example.com/auth/reset-password?token=tok-123');
  });

  it('honours an explicit absolute link', () => {
    expect(resolve({ appUrl: 'https://example.com', passwordResetLink: 'https://other.example.com/reset' })).toBe(
      'https://other.example.com/reset?token=tok-123',
    );
  });

  it('resolves a relative link against the app URL', () => {
    expect(resolve({ appUrl: 'https://example.com', passwordResetLink: '/account/new-password' })).toBe(
      'https://example.com/account/new-password?token=tok-123',
    );
  });

  it('substitutes {token} wherever it appears', () => {
    // What lets a page reading a PATH parameter work — the placeholder, rather than a second
    // config option describing the shape.
    expect(
      resolve({ appUrl: 'https://example.com', passwordResetLink: 'https://example.com/reset/{token}' }),
    ).toBe('https://example.com/reset/tok-123');
  });

  it('appends with & when the configured link already carries a query', () => {
    expect(resolve({ appUrl: 'https://example.com', passwordResetLink: 'https://example.com/reset?lang=de' })).toBe(
      'https://example.com/reset?lang=de&token=tok-123',
    );
  });

  it('keeps Better-Auth\'s own link when explicitly set to false', () => {
    // The opt-out for anyone who wants the early token validation the API hop performs.
    expect(resolve({ appUrl: 'https://example.com', passwordResetLink: false })).toBe(BETTER_AUTH_URL);
  });

  it('falls back to Better-Auth\'s link when no app URL can be resolved', () => {
    // A guessed link would be worse than the working one: it would 404 on a host we invented.
    expect(resolve({})).toBe(BETTER_AUTH_URL);
    expect(resolve({ passwordResetLink: '/auth/reset-password' })).toBe(BETTER_AUTH_URL);
  });

  it('treats a blank configured value as unset rather than as a link', () => {
    expect(resolve({ appUrl: 'https://example.com', passwordResetLink: '   ' })).toBe(
      'https://example.com/auth/reset-password?token=tok-123',
    );
  });

  it('is what sendPasswordResetEmail actually mails', async () => {
    // The resolver being correct is worthless if the mailer does not call it. That is not a
    // hypothetical: the first version of this suite tested the resolver alone, and the registered
    // mutation — which removes the CALL — stayed green. The gate caught it as vacuous.
    const service = Object.create(CoreBetterAuthEmailVerificationService.prototype) as any;
    service.config = { enabled: true, locale: 'en', template: 'password-reset' };
    service.configService = { getFastButReadOnly: (key: string) => (key === 'appUrl' ? 'https://example.com' : undefined) };
    service.logger = { debug: () => undefined, error: () => undefined, log: () => undefined, warn: () => undefined };
    service.brevoService = undefined;
    service.acquireSendSlot = async () => 'slot';
    service.releaseSendSlot = async () => undefined;
    service.getAppName = () => 'Test';
    service.maskEmail = (value: string) => value;
    service.logAuthUrlForDevelopment = () => undefined;

    let mailedLink: string | undefined;
    service.emailService = {
      sendMail: async (_to: string, _subject: string, config: any) => {
        mailedLink = config?.templateData?.link;
        return true;
      },
    };
    service.resolveTemplatePath = () => ({ isAbsolute: false, path: 'password-reset' });

    await service.sendPasswordResetEmail({
      token: 'tok-123',
      url: BETTER_AUTH_URL,
      user: { email: 'someone@test.com', id: 'u1' },
    });

    expect(mailedLink, 'the mail must carry the resolved app link, not Better-Auth\'s API link').toBe(
      'https://example.com/auth/reset-password?token=tok-123',
    );
  });

  it('encodes the token', () => {
    const service = Object.create(CoreBetterAuthEmailVerificationService.prototype) as any;
    service.config = {};
    service.configService = { getFastButReadOnly: () => 'https://example.com' };

    const url = service.buildPasswordResetUrl({
      token: 'a b&c',
      url: BETTER_AUTH_URL,
      user: { email: 'someone@test.com', id: 'u1' },
    });

    // A token is opaque and generated, so this is defence rather than a live case — but a raw `&`
    // in a query value silently truncates the parameter, and the failure would look like an
    // invalid token rather than a broken link.
    expect(url).toBe('https://example.com/auth/reset-password?token=a%20b%26c');
  });
});
