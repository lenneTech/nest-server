import { describe, expect, it, vi } from 'vitest';

import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';

/**
 * The link in the email-verification mail carries the token and nothing else.
 *
 * From 11.38.0 to DEV-4056 it carried the address too (`&email=`), so the verification page could offer "send a new
 * email" for an expired link. That put a personal address into the mail's URL, the browser history and every access
 * log the app keeps. The page now asks for a new mail with the token alone (`POST /iam/resend-verification-email`,
 * tests/unit/better-auth-resend-verification.spec.ts): the server reads the address from the token and answers it
 * masked, so the expired link stays recoverable without the address ever being in a URL.
 *
 * The existing coverage in `tests/stories/better-auth-email-verification.story.test.ts` sits behind
 * `if (config.callbackURL)`, so it asserts nothing when that config is absent. These cases are unconditional on purpose.
 */
describe('CoreBetterAuthEmailVerificationService.buildFrontendVerificationUrl', () => {
  /**
   * Reaches the protected builder with a hand-built config. The method is `protected` because a project may override
   * it, so the test calls it the way a subclass would — the second argument is what a caller of the 11.38.0 signature
   * still passes.
   */
  const build = (options: { appUrl?: string; callbackURL: string; email?: string; token?: string }): string => {
    const service = Object.create(CoreBetterAuthEmailVerificationService.prototype) as any;
    service.config = { callbackURL: options.callbackURL };
    service.configService = {
      getFastButReadOnly: (key: string) => (key === 'appUrl' ? options.appUrl : undefined),
    };

    return service.buildFrontendVerificationUrl(options.token ?? 'tok-123', options.email);
  };

  /**
   * @regression   DEV-4056 — the link carried the address (`&email=`), so it stood in the mail, in the browser history
   *   and in the access logs of the app.
   * @seen-failing Append the second argument as `&email=` in buildFrontendVerificationUrl() in
   *   src/core/modules/better-auth/core-better-auth-email-verification.service.ts — registered as mutation
   *   `verification-link-carries-email` in tests/regression-mutations.json.
   */
  it('carries the token and no address, even when a caller passes one', () => {
    const url = build({
      appUrl: 'https://example.com',
      callbackURL: '/auth/verify-email',
      email: 'someone@test.com',
    });

    expect(url).toBe('https://example.com/auth/verify-email?token=tok-123');
    // Specifically the PARAMETER and the address — the path itself is spelled `verify-email`
    expect(url).not.toContain('email=');
    expect(url).not.toContain('someone');
  });

  it('encodes the token', () => {
    const url = build({ appUrl: 'https://example.com', callbackURL: '/auth/verify-email', token: 'a+b/c=' });

    expect(url).toBe('https://example.com/auth/verify-email?token=a%2Bb%2Fc%3D');
  });

  it('uses & when the configured callbackURL already carries a query', () => {
    const url = build({ callbackURL: 'https://example.com/verify?lang=de' });

    expect(url).toBe('https://example.com/verify?lang=de&token=tok-123');
  });

  it('resolves a relative callbackURL against the app URL', () => {
    const url = build({ appUrl: 'https://example.com/', callbackURL: '/auth/verify-email' });

    expect(url).toBe('https://example.com/auth/verify-email?token=tok-123');
  });
});

/**
 * Where a relative `callbackURL` (the default `/auth/verify-email`) points when `appUrl` is not configured (DEV-4140).
 *
 * The builder read `appUrl` straight off the configuration and fell back to `http://localhost:3001`, so every deployed
 * stage without `NSC__APP_URL` mailed a verification link to localhost — although the app's address follows from
 * `NSC__BASE_URL`, which the starter requires on every deployed stage, and the password-reset link already resolved it
 * that way. The link now asks the same resolver (`resolveAppUrlFromConfig()`: explicit `appUrl`, the localhost default
 * in `local` / `ci` / `e2e`, else derived from `baseUrl`). Where nothing resolves, the mail keeps Better-Auth's own link
 * to the API, which verifies and works, rather than a guessed host.
 */
describe('CoreBetterAuthEmailVerificationService: the verification link follows the resolved app URL', () => {
  const service = (config: Record<string, unknown>, callbackURL = '/auth/verify-email'): any => {
    const instance = Object.create(CoreBetterAuthEmailVerificationService.prototype) as any;
    instance.config = { callbackURL };
    instance.configService = { getFastButReadOnly: (key: string) => config[key] };
    instance.logger = { debug: () => undefined, warn: vi.fn() };
    return instance;
  };
  const betterAuthLink = 'https://api.crm.example.com/iam/verify-email?token=sealed&callbackURL=%2F';

  /**
   * @regression   DEV-4140 — without `appUrl`, the verification link pointed at `http://localhost:3001` on every deployed
   *   stage, although the app URL follows from `baseUrl`.
   * @seen-failing Restore `this.configService.getFastButReadOnly<string>('appUrl') || 'http://localhost:3001'` in
   *   buildFrontendVerificationUrl() in src/core/modules/better-auth/core-better-auth-email-verification.service.ts —
   *   registered as mutation `verification-link-localhost-without-app-url` in tests/regression-mutations.json.
   */
  it('derives the app URL from baseUrl on a deployed stage without appUrl', () => {
    const url = service({ baseUrl: 'https://api.crm.example.com', env: 'develop' }).buildFrontendVerificationUrl('tok');

    expect(url).toBe('https://crm.example.com/auth/verify-email?token=tok');
  });

  it('never links to localhost on a deployed stage, also when nothing resolves', () => {
    for (const config of [
      { env: 'develop' },
      { env: 'production' },
      { baseUrl: 'https://api.crm.example.com', 'cors.deriveAppUrl': false, env: 'test' },
    ]) {
      const url = service(config).buildFrontendVerificationUrl('tok');
      expect(url ?? '', JSON.stringify(config)).not.toContain('localhost');
    }
  });

  /**
   * @regression   DEV-4140 — the mail must carry a working link when no app URL resolves; a builder that answers
   *   nothing for a relative callbackURL must not leave the mail without one.
   * @seen-failing Drop `?? options.url` from verificationMailUrl() in
   *   src/core/modules/better-auth/core-better-auth-email-verification.service.ts — registered as mutation
   *   `verification-mail-drops-better-auth-link` in tests/regression-mutations.json.
   */
  it("keeps Better-Auth's own link, and warns, when no app URL resolves", () => {
    const instance = service({ env: 'production' });

    expect(instance.verificationMailUrl({ token: 'sealed', url: betterAuthLink })).toBe(betterAuthLink);
    expect(instance.logger.warn).toHaveBeenCalledWith(expect.stringContaining('NSC__APP_URL'));
  });

  it('honours cors.deriveAppUrl: false and falls back to the link Better-Auth built', () => {
    const instance = service({ baseUrl: 'https://api.crm.example.com', 'cors.deriveAppUrl': false, env: 'production' });

    expect(instance.verificationMailUrl({ token: 'sealed', url: betterAuthLink })).toBe(betterAuthLink);
  });

  it('paired control: an explicit appUrl still wins, and local environments keep the localhost default', () => {
    expect(
      service({ appUrl: 'https://app.example.com', baseUrl: 'https://api.crm.example.com', env: 'production' })
        .verificationMailUrl({ token: 'tok', url: betterAuthLink }),
    ).toBe('https://app.example.com/auth/verify-email?token=tok');
    expect(service({ env: 'local' }).buildFrontendVerificationUrl('tok')).toBe(
      'http://localhost:3001/auth/verify-email?token=tok',
    );
  });

  it('paired control: an absolute callbackURL needs no app URL at all', () => {
    expect(
      service({ env: 'production' }, 'https://app.example.com/verify').verificationMailUrl({
        token: 'tok',
        url: betterAuthLink,
      }),
    ).toBe('https://app.example.com/verify?token=tok');
  });
});
