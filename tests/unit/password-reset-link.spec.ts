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
 * @seen-failing Two registered mutations in tests/regression-mutations.json:
 *     password-reset-link-ignores-config    returns Better-Auth's URL unconditionally, i.e.
 *                                           restores the pass-through
 *     password-reset-link-ignores-redirectto drops the caller's own `redirectTo`, so a project
 *                                           that renamed its reset page is mailed the default one
 *     iam-reset-link-raw-appurl             reverts to reading `appUrl` straight off the config,
 *                                           losing the localhost default, the host-split `baseUrl`
 *                                           derivation and the `cors.deriveAppUrl` opt-out that the
 *                                           legacy twin already had
 */

import { describe, expect, it } from 'vitest';

import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';

/**
 * Better-Auth's own link WITHOUT a `callbackURL`, i.e. the shape produced when the caller sent no
 * `redirectTo`. That is the default fixture here on purpose: every case below predates
 * `redirectTo` handling and asks what the SERVER resolves on its own. Giving them a link that
 * carries a callback would silently re-point them at the caller's page and quietly change what
 * they assert. The `redirectTo` cases are grouped separately at the bottom.
 */
const BETTER_AUTH_URL = 'https://api.example.com/iam/reset-password/tok-123?callbackURL=';

/** Better-Auth's link as it looks when the caller DID send a `redirectTo`. */
const betterAuthUrlWithCallback = (redirectTo: string): string =>
  `https://api.example.com/iam/reset-password/tok-123?callbackURL=${encodeURIComponent(redirectTo)}`;

/**
 * Reaches the protected resolver with a hand-built config, without constructing the whole service.
 *
 * The method is `protected` on purpose — a project may override it — so the test calls it the way
 * a subclass would rather than through a public surface that does not exist.
 */
const resolve = (options: {
  appUrl?: string;
  baseUrl?: string;
  deriveAppUrl?: boolean;
  env?: string;
  passwordResetLink?: false | string;
  redirectTo?: string;
}): string => {
  const service = Object.create(CoreBetterAuthEmailVerificationService.prototype) as any;
  service.config = { passwordResetLink: options.passwordResetLink };
  service.configService = {
    getFastButReadOnly: (key: string) =>
      ({
        appUrl: options.appUrl,
        baseUrl: options.baseUrl,
        'cors.deriveAppUrl': options.deriveAppUrl,
        env: options.env,
      })[key],
  };

  return service.buildPasswordResetUrl({
    token: 'tok-123',
    url: options.redirectTo ? betterAuthUrlWithCallback(options.redirectTo) : BETTER_AUTH_URL,
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
    expect(resolve({ appUrl: 'https://example.com', passwordResetLink: 'https://example.com/reset/{token}' })).toBe(
      'https://example.com/reset/tok-123',
    );
  });

  it('appends with & when the configured link already carries a query', () => {
    expect(resolve({ appUrl: 'https://example.com', passwordResetLink: 'https://example.com/reset?lang=de' })).toBe(
      'https://example.com/reset?lang=de&token=tok-123',
    );
  });

  it("keeps Better-Auth's own link when explicitly set to false", () => {
    // The opt-out for anyone who wants the early token validation the API hop performs.
    expect(resolve({ appUrl: 'https://example.com', passwordResetLink: false })).toBe(BETTER_AUTH_URL);
  });

  it("falls back to Better-Auth's link when no app URL can be resolved", () => {
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
    service.configService = {
      getFastButReadOnly: (key: string) => (key === 'appUrl' ? 'https://example.com' : undefined),
    };
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

    expect(mailedLink, "the mail must carry the resolved app link, not Better-Auth's API link").toBe(
      'https://example.com/auth/reset-password?token=tok-123',
    );
  });

  /**
   * `redirectTo` is the caller naming its own reset page, and `nuxt-base-starter` sends it on every
   * request. A framework default that overrode it would be the server overruling a client that
   * knows better — and it would break the moment a project renames that page.
   *
   * Honouring it also restores true equivalence with Better-Auth's own hop: the hop redirects to
   * `callbackURL?token=`, so a direct link built from the same value lands the user in exactly the
   * same place, minus the round trip.
   *
   * Safety of reading it back is NOT self-evident — `redirectTo` arrives in the body of an
   * unauthenticated endpoint — and rests entirely on Better-Auth running `originCheck` on it at
   * request time. See readCallbackUrlFromBetterAuthLink() for the full argument.
   */
  describe("the caller's own redirectTo", () => {
    it('wins over the framework default', () => {
      expect(resolve({ appUrl: 'https://example.com', redirectTo: 'https://example.com/auth/reset-password' })).toBe(
        'https://example.com/auth/reset-password?token=tok-123',
      );
    });

    it('wins even when it names a different page than the default would', () => {
      // The case that matters in practice: a project renamed its reset route. The default would
      // have sent the recipient to a page that does not exist.
      expect(resolve({ appUrl: 'https://example.com', redirectTo: 'https://example.com/konto/neues-passwort' })).toBe(
        'https://example.com/konto/neues-passwort?token=tok-123',
      );
    });

    it('is still beaten by an explicit server-side configuration', () => {
      // Deliberate order: a deployment that pinned the link did so knowing more than the caller.
      expect(
        resolve({
          appUrl: 'https://example.com',
          passwordResetLink: 'https://pinned.example.com/reset',
          redirectTo: 'https://example.com/auth/reset-password',
        }),
      ).toBe('https://pinned.example.com/reset?token=tok-123');
    });

    it('carries the link when no app URL can be resolved at all', () => {
      // Without it this would fall through to Better-Auth's API link. The caller told us where to
      // go, so there is nothing left to guess.
      expect(resolve({ redirectTo: 'https://example.com/auth/reset-password' })).toBe(
        'https://example.com/auth/reset-password?token=tok-123',
      );
    });

    it('does not override an explicit opt-out', () => {
      // `false` means "keep Better-Auth's link, including its early token validation". A caller's
      // redirectTo must not quietly undo a deployment's decision to keep that hop.
      expect(resolve({ passwordResetLink: false, redirectTo: 'https://example.com/auth/reset-password' })).toBe(
        betterAuthUrlWithCallback('https://example.com/auth/reset-password'),
      );
    });
  });

  /**
   * The app URL is resolved by the SAME function the legacy twin uses (`resolveAppUrlFromConfig`).
   *
   * Until 11.39.0 this method read `appUrl` straight off the configuration while its legacy twin
   * had been moved to the shared resolver — two hand-maintained copies of one decision, and they
   * drifted. The registry even asserted the raw read was a defect on one side
   * (`legacy-reset-link-raw-appurl`) while tolerating it here.
   *
   * Each case below is a behaviour the twin had and this one did not.
   */
  describe('app-URL resolution, shared with the legacy twin', () => {
    it('uses the localhost default in local/ci/e2e, where nothing is configured', () => {
      // Those three environments do not set `appUrl` — their default lives inside
      // `resolveServerUrls`. A raw read yielded nothing here, so the mail fell back to
      // Better-Auth's API-hosted link in every local environment.
      expect(resolve({ env: 'e2e' })).toBe('http://localhost:3001/auth/reset-password?token=tok-123');
    });

    it('derives the app origin from a host-split baseUrl', () => {
      // What `lt dev up` serves: API and app separated by host rather than port.
      expect(resolve({ baseUrl: 'https://api.crm.localhost', env: 'local' })).toBe(
        'https://crm.localhost/auth/reset-password?token=tok-123',
      );
    });

    it('derives the app origin from a deployed baseUrl', () => {
      expect(resolve({ baseUrl: 'https://api.example.com', env: 'production' })).toBe(
        'https://example.com/auth/reset-password?token=tok-123',
      );
    });

    it('does not derive an origin the project excluded from trust', () => {
      // `cors.deriveAppUrl: false` states that the apex domain is NOT ours. Deriving anyway would
      // mail a reset token to a third party's origin. With nothing resolvable, Better-Auth's own
      // link is the honest fallback — it works and it points at our API.
      expect(resolve({ baseUrl: 'https://api.example.com', deriveAppUrl: false, env: 'production' })).toBe(
        BETTER_AUTH_URL,
      );
    });

    it('still derives when nothing opted out', () => {
      // The paired permissive case: a change that disabled derivation everywhere would satisfy the
      // assertion above and look like a pass.
      expect(resolve({ baseUrl: 'https://api.example.com', env: 'production' })).not.toBe(BETTER_AUTH_URL);
    });
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
