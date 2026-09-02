import { CoreUserService } from '../../src/core/modules/user/core-user.service';

/**
 * `buildPasswordResetLink` is the one place a project should build the link that goes into the
 * password-reset mail — and the reason it exists is a failure that reached real recipients.
 *
 * `email.passwordResetLink` had no default and nothing validated it. A project that never set it
 * concatenated `undefined` with the token and sent `…/auth/reset-password/undefined`. It is the
 * worst shape a bug can take: the request succeeds, the mail arrives, it looks right, and only the
 * click reveals it — to somebody who by definition has no second way in.
 *
 * The assertions below are therefore not about formatting. Each one is a way this has failed or
 * could fail silently.
 *
 * The IAM flow's twin, `CoreBetterAuthEmailVerificationService.buildPasswordResetUrl`, is covered
 * by `password-reset-link.spec.ts`. Two flows, two conventions (path segment here, `?token=`
 * there), two files.
 *
 * @regression   11.38.0 — `email.passwordResetLink` had no default and nothing validated it, so a
 *   project that never set it mailed `…/auth/reset-password/undefined`; `appUrl` was read raw, so
 *   the fallback returned nothing in every local environment; and once it was resolved through
 *   `resolveServerUrls`, the `cors.deriveAppUrl` opt-out was not forwarded, so the app origin was
 *   derived even for a deployment that had switched that derivation off.
 * @seen-failing Five registered mutations in tests/regression-mutations.json, one per behaviour:
 *     legacy-reset-link-raw-appurl                    restores the raw `appUrl` read
 *     legacy-reset-link-concatenates-undefined        restores the bare concatenation
 *     legacy-reset-link-ignores-derive-optout         drops the `deriveAppUrl` forward
 *     legacy-reset-link-fallback-path-segment         reverts the fallback to a path segment
 *     legacy-reset-link-convention-warning-disarmed   silences the boot warning
 *     reset-link-warning-omits-precondition          drops the precondition from its text
 */
/**
 * Only the one method under test. The class itself is generic over three model types, and
 * instantiating it here would test the type parameters rather than the link.
 */
interface LinkBuilder {
  buildPasswordResetLink(token: string): null | string;
  warnOnAmbiguousResetLinkConvention(): void;
}

describe('CoreUserService.buildPasswordResetLink (legacy flow)', () => {
  /**
   * Minimal stand-in for the service: only the config lookup and the logger are involved, so
   * building a full Nest context would test the container rather than the decision.
   */
  function serviceWith(config: Record<string, boolean | undefined | string>, warnings: string[] = []): LinkBuilder {
    const service = Object.create(CoreUserService.prototype) as Record<string, unknown>;
    service.configService = { getFastButReadOnly: (key: string) => config[key] };
    service.userServiceLogger = {
      debug: () => undefined,
      error: () => undefined,
      warn: (message: string) => warnings.push(message),
    };
    return service as unknown as LinkBuilder;
  }

  const TOKEN = 'a'.repeat(64);

  it('appends the token as a path segment, the convention this flow has always used', () => {
    const service = serviceWith({ 'email.passwordResetLink': 'https://example.com/auth/reset-password' });

    expect(service.buildPasswordResetLink(TOKEN)).toBe(`https://example.com/auth/reset-password/${TOKEN}`);
  });

  it('treats a configured value that LOOKS like the default as a configured value', () => {
    // The trap this convention creates, pinned deliberately. Writing the default out by hand —
    // to make it env-overridable, or to derive it from appUrl — yields a DIFFERENT link than
    // leaving the line out, because the fallback carries a `{token}` placeholder and a configured
    // value without one still gets a path segment.
    //
    // This is not the behaviour anybody would guess, and it is kept on purpose: a project that
    // already configures such a value has a page built for a path segment, and quietly moving it
    // to `?token=` would break exactly the flow this whole change exists to repair. The boot
    // warning is what makes it discoverable — see warnOnAmbiguousResetLinkConvention().
    const configured = serviceWith({ 'email.passwordResetLink': 'https://example.com/auth/reset-password' });
    const fallback = serviceWith({ appUrl: 'https://example.com' });

    expect(configured.buildPasswordResetLink(TOKEN)).toBe(`https://example.com/auth/reset-password/${TOKEN}`);
    expect(fallback.buildPasswordResetLink(TOKEN)).toBe(`https://example.com/auth/reset-password?token=${TOKEN}`);
  });

  it('falls back to the app URL when the option was never set', () => {
    // The case that produced `undefined/<token>`: nothing configured, and the caller concatenated
    // anyway. A sensible fallback is better than a link nobody can use.
    const service = serviceWith({ appUrl: 'https://example.com' });

    expect(service.buildPasswordResetLink(TOKEN)).toBe(`https://example.com/auth/reset-password?token=${TOKEN}`);
  });

  it('returns null rather than a link containing "undefined"', () => {
    // Neither option available. Returning null lets the caller send nothing, which is the honest
    // failure: a mail that does not arrive says "try again", one with a dead link says nothing.
    const service = serviceWith({});

    expect(service.buildPasswordResetLink(TOKEN)).toBeNull();
  });

  it('never produces the string "undefined", whatever is missing', () => {
    for (const config of [{}, { appUrl: undefined }, { 'email.passwordResetLink': undefined }]) {
      const link = serviceWith(config).buildPasswordResetLink(TOKEN);
      expect(link === null || !link.includes('undefined')).toBe(true);
    }
  });

  it('uses the localhost default in local/ci/e2e, where nothing is configured', () => {
    // The case that made the e2e run red: the framework's own test environments set neither
    // option, and a raw read of `appUrl` returned nothing. `resolveServerUrls` gives those three
    // environments their documented localhost default, so a project gets a working link locally
    // without configuring anything.
    const service = serviceWith({ env: 'e2e' });

    expect(service.buildPasswordResetLink(TOKEN)).toBe(`http://localhost:3001/auth/reset-password?token=${TOKEN}`);
  });

  it('derives the app origin from a host-split baseUrl', () => {
    // What `lt dev up` produces: API and app separated by host rather than port. Deriving from
    // the port-split default would point the link at the API's own origin.
    const service = serviceWith({ baseUrl: 'https://api.crm.localhost', env: 'local' });

    expect(service.buildPasswordResetLink(TOKEN)).toBe(`https://crm.localhost/auth/reset-password?token=${TOKEN}`);
  });

  it('does not derive an app origin the project excluded from trust', () => {
    // `cors.deriveAppUrl: false` is how a deployment states that the apex domain is NOT ours — the
    // documented case is a third-party-hosted marketing site. `buildCorsConfig` honours it; this
    // method resolves through the same helper, so ignoring the flag here would mail a reset token
    // to that origin, where it lands in a third party's access log. A password-reset link is a
    // bearer credential, so the flag matters MORE here than it does for a CORS grant.
    const service = serviceWith({
      baseUrl: 'https://api.example.com',
      'cors.deriveAppUrl': false,
      env: 'production',
    });

    // Null, not a guess: the caller then sends nothing, which is the honest failure.
    expect(service.buildPasswordResetLink(TOKEN)).toBeNull();
  });

  it('still derives the app origin when nothing opted out', () => {
    // The paired permissive case. Without it, a regression that disabled derivation everywhere
    // would satisfy the assertion above and look like a pass.
    const service = serviceWith({ baseUrl: 'https://api.example.com', env: 'production' });

    expect(service.buildPasswordResetLink(TOKEN)).toBe(`https://example.com/auth/reset-password?token=${TOKEN}`);
  });

  it('substitutes {token} anywhere in the value', () => {
    const service = serviceWith({
      'email.passwordResetLink': 'https://example.com/reset?t={token}&lang=de',
    });

    expect(service.buildPasswordResetLink(TOKEN)).toBe(`https://example.com/reset?t=${TOKEN}&lang=de`);
  });

  it('resolves a relative value against the app URL', () => {
    const service = serviceWith({ appUrl: 'https://example.com/', 'email.passwordResetLink': '/neu' });

    expect(service.buildPasswordResetLink(TOKEN)).toBe(`https://example.com/neu/${TOKEN}`);
  });

  /**
   * The warning is the only thing standing between the two conventions and a silent mismatch, so
   * it gets the same treatment as the link itself: the case it must fire on, AND the two it must
   * stay quiet on. A warning that fires always is ignored, and one that never fires is absent.
   */
  describe('warnOnAmbiguousResetLinkConvention', () => {
    it('warns when a configured value carries no {token} placeholder', () => {
      const warnings: string[] = [];
      serviceWith({ 'email.passwordResetLink': 'https://example.com/auth/reset-password' }, warnings)
        .warnOnAmbiguousResetLinkConvention();

      expect(warnings).toHaveLength(1);
      // Naming both shapes is the point — the reader has to be able to act without looking it up.
      expect(warnings[0]).toContain('{token}');
      expect(warnings[0]).toContain('?token=');
    });

    it('names the precondition, not just the remedy', () => {
      // Found by a project following this warning's advice: `{token}` is substituted by
      // `buildPasswordResetLink()` and by nothing else. A caller that still concatenates the link
      // by hand — which is exactly who this warning reaches — would add the placeholder and mail
      // `/reset-password/{token}/<token>`. Advice that is correct for half its audience and
      // silently harmful to the other half is worse than none, so the order of the two steps is
      // part of the message and is asserted here.
      const warnings: string[] = [];
      serviceWith({ 'email.passwordResetLink': 'https://example.com/auth/reset-password' }, warnings)
        .warnOnAmbiguousResetLinkConvention();

      expect(warnings[0]).toContain('buildPasswordResetLink');
    });

    it('stays quiet when the convention was stated explicitly', () => {
      for (const value of ['https://example.com/auth/reset-password/{token}', '/auth/reset-password?token={token}']) {
        const warnings: string[] = [];
        serviceWith({ 'email.passwordResetLink': value }, warnings).warnOnAmbiguousResetLinkConvention();
        expect(warnings, `should not warn for ${value}`).toHaveLength(0);
      }
    });

    it('stays quiet when the option is unset, which is the unambiguous case', () => {
      const warnings: string[] = [];
      serviceWith({ appUrl: 'https://example.com' }, warnings).warnOnAmbiguousResetLinkConvention();

      expect(warnings).toHaveLength(0);
    });
  });

  it('does not double the slash when the configured value ends in one', () => {
    const service = serviceWith({ 'email.passwordResetLink': 'https://example.com/reset/' });

    expect(service.buildPasswordResetLink(TOKEN)).toBe(`https://example.com/reset/${TOKEN}`);
  });
});
