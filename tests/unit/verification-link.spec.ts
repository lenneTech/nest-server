import { describe, expect, it } from 'vitest';

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
