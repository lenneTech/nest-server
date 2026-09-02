import { describe, expect, it } from 'vitest';

import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';

/**
 * The link in the email-verification mail, and specifically the one thing it used to leave out.
 *
 * `buildFrontendVerificationUrl` carried only the token. That is enough while the token is valid
 * and useless the moment it is not: the verification page shipped by nuxt-base-starter gates its
 * "send a new email" button on `route.query.email`, so an expired link produced a correct
 * explanation and no way to act on it — a dead end reached exactly by the people who most need the
 * button.
 *
 * The page cannot recover the address on its own. It sits in the token's JWT payload, and reading
 * it there would mean displaying data from an unverified signature.
 *
 * The existing coverage in `tests/stories/better-auth-email-verification.story.test.ts` sits behind
 * `if (config.callbackURL)`, so it asserts nothing when that config is absent. These cases are
 * unconditional on purpose.
 *
 * @regression   11.38.0 — the verification link omitted the address, so the resend button could
 *   never render and an expired link was unrecoverable from the page it landed on.
 * @seen-failing Registered mutation `verification-link-omits-email` in
 *   tests/regression-mutations.json — drops the address from the URL again.
 */
describe('CoreBetterAuthEmailVerificationService.buildFrontendVerificationUrl', () => {
  /**
   * Reaches the protected builder with a hand-built config. The method is `protected` because a
   * project may override it, so the test calls it the way a subclass would.
   */
  const build = (options: { appUrl?: string; callbackURL: string; email?: string; token?: string }): string => {
    const service = Object.create(CoreBetterAuthEmailVerificationService.prototype) as any;
    service.config = { callbackURL: options.callbackURL };
    service.configService = {
      getFastButReadOnly: (key: string) => (key === 'appUrl' ? options.appUrl : undefined),
    };

    return service.buildFrontendVerificationUrl(options.token ?? 'tok-123', options.email);
  };

  it('carries the address alongside the token', () => {
    const url = build({
      appUrl: 'https://example.com',
      callbackURL: '/auth/verify-email',
      email: 'someone@test.com',
    });

    expect(url).toBe('https://example.com/auth/verify-email?token=tok-123&email=someone%40test.com');
  });

  it('encodes a "+" in the address instead of turning it into a space', () => {
    // Gmail tags — and therefore most test addresses. Unencoded, `+` decodes to a space on the
    // page and the resend call then fails for an address that does exist.
    const url = build({
      appUrl: 'https://example.com',
      callbackURL: '/auth/verify-email',
      email: 'kai+iam@test.com',
    });

    expect(url).toContain('email=kai%2Biam%40test.com');
    expect(url).not.toContain('kai+iam');
  });

  it('omits the parameter entirely when no address is given', () => {
    // An overriding subclass may still call the single-argument form. It must produce a working
    // link, not one ending in `&email=undefined`.
    const url = build({ appUrl: 'https://example.com', callbackURL: '/auth/verify-email' });

    expect(url).toBe('https://example.com/auth/verify-email?token=tok-123');
    // Specifically the PARAMETER — the path itself is spelled `verify-email`, so a bare substring
    // check would pass for the wrong reason.
    expect(url).not.toContain('email=');
    expect(url).not.toContain('undefined');
  });

  it('uses & when the configured callbackURL already carries a query', () => {
    const url = build({
      callbackURL: 'https://example.com/verify?lang=de',
      email: 'someone@test.com',
    });

    expect(url).toBe('https://example.com/verify?lang=de&token=tok-123&email=someone%40test.com');
  });

  it('resolves a relative callbackURL against the app URL', () => {
    const url = build({ appUrl: 'https://example.com/', callbackURL: '/auth/verify-email', email: 'a@test.com' });

    expect(url).toBe('https://example.com/auth/verify-email?token=tok-123&email=a%40test.com');
  });
});
