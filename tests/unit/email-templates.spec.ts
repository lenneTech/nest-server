/**
 * The shipped EJS mail templates, checked against the data their real callers actually pass.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A template is code that is never imported, never type-checked and never linted — the only thing
 * that binds it to its caller is the set of variable names inside it, and EJS resolves those at
 * RENDER time. So a template can gain a variable its caller does not pass and nothing anywhere
 * says so until a user asks for a password reset and gets an HTTP 500.
 *
 * That is not hypothetical: rewriting `password-reset.ejs` to a branded HTML mail introduced
 * `<%= appName %>`, which `UserService.sendPasswordResetMail()` does not pass — it sends
 * `{ link, name }` only. Password recovery broke on the legacy route, in this repo and in every
 * consumer that does not ship its own copy of the template.
 *
 * The rule these cases encode: EVERY caller shape a template can be reached with must render.
 *
 * @regression   11.36.1 — `src/templates/password-reset.ejs` referenced `appName`, which the
 *   legacy caller (`src/server/modules/user/user.service.ts`, and the byte-identical call in
 *   nest-server-starter) does not supply. `ejs.compile(tpl)({ link, name })` threw
 *   `ReferenceError: appName is not defined`, so `POST /users/password/reset-request` answered 500
 *   and no reset mail was ever sent.
 * @seen-failing Two registered mutations: `password-reset-template-requires-appname` (re-introduce
 *   an unguarded `<%= appName %>`) and `reset-mail-omits-deadline` (drop the expiry sentence, so an
 *   expired link becomes indistinguishable from a broken one). Registered in
 *   `tests/regression-mutations.json`. Only the legacy-shape cases go red; the BetterAuth-shape
 *   cases stay green, which is what distinguishes the defect from a broken fixture.
 */
import ejs = require('ejs');
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'src', 'templates');

function render(templateName: string, data: Record<string, unknown>): string {
  const source = fs.readFileSync(path.join(TEMPLATES_DIR, `${templateName}.ejs`), 'utf-8');
  return ejs.compile(source)(data);
}

/**
 * What `UserService.sendPasswordResetMail()` passes — the LEGACY REST/GraphQL reset flow.
 * Deliberately minimal: this is the contract, not a convenience fixture.
 */
const LEGACY_SHAPE = {
  link: 'https://app.test.local/reset/abc123',
  linkExpiresInMinutes: 60,
  name: 'Legacy Caller',
};

/** What `CoreBetterAuthEmailVerificationService.sendPasswordResetEmail()` passes. */
const BETTER_AUTH_SHAPE = {
  appName: 'Acme',
  link: 'https://api.test.local/iam/reset-password/abc123',
  linkExpiresInMinutes: 60,
  name: 'IAM Caller',
};

describe('password-reset templates', () => {
  it('the un-suffixed template renders with the LEGACY caller shape', () => {
    // `htmlTemplate: 'password-reset'` resolves to exactly this file, and the legacy caller passes
    // no appName. Breaking this breaks password recovery for every consumer without its own copy.
    const html = render('password-reset', LEGACY_SHAPE);

    expect(html).toContain(LEGACY_SHAPE.link);
    expect(html).toContain(LEGACY_SHAPE.name);
  });

  it('the un-suffixed template also renders with the BetterAuth shape', () => {
    // resolveTemplatePath() falls through to it for any locale without its own variant.
    expect(render('password-reset', BETTER_AUTH_SHAPE)).toContain(BETTER_AUTH_SHAPE.link);
  });

  for (const locale of ['de', 'en']) {
    it(`the ${locale} template renders with the BetterAuth shape`, () => {
      const html = render(`password-reset-${locale}`, BETTER_AUTH_SHAPE);

      expect(html).toContain(BETTER_AUTH_SHAPE.link);
      expect(html).toContain(BETTER_AUTH_SHAPE.appName);
    });

    it(`the ${locale} template survives a caller that omits appName`, () => {
      // Defense in depth: a project may reuse these templates from its own service.
      expect(() => render(`password-reset-${locale}`, LEGACY_SHAPE)).not.toThrow();
    });

    it(`the ${locale} template states the deadline when one was supplied`, () => {
      // Since 11.38.0 the reset token expires. The mail is the ONLY place the recipient can learn
      // that, and without it an expired link is indistinguishable from a broken one — the same
      // experience this whole area was repaired for.
      const html = render(`password-reset-${locale}`, BETTER_AUTH_SHAPE);

      // NOT `toContain('60')` — both templates carry `max-width:600px` and `font-weight:600`
      // unconditionally, so that assertion passes with the whole deadline block deleted. The
      // sentence has to be asserted as one string, or the substitution itself goes unverified.
      expect(html).toMatch(locale === 'de' ? /60 Minuten lang g(ü|&#252;)ltig/ : /valid for 60 minutes/);
    });

    it(`the ${locale} template states NO deadline when expiry is switched off`, () => {
      // `tokenExpiresInMinutes: 0` means the link never expires, so there is nothing to announce.
      // Printing "valid for 0 minutes" would be worse than silence.
      const html = render(`password-reset-${locale}`, { ...BETTER_AUTH_SHAPE, linkExpiresInMinutes: 0 });

      expect(html).not.toMatch(locale === 'de' ? /Minuten lang g/ : /valid for/);
    });

    it(`the ${locale} template survives a caller that omits the deadline entirely`, () => {
      // A project with its own mail service predates this field. Omitting it must degrade to no
      // sentence, never to a 500 on the one route that gets a locked-out user back in.
      const { linkExpiresInMinutes: _omitted, ...withoutExpiry } = BETTER_AUTH_SHAPE;

      expect(() => render(`password-reset-${locale}`, withoutExpiry)).not.toThrow();
    });

    it(`the ${locale} template renders the optional logoSrc when supplied`, () => {
      const html = render(`password-reset-${locale}`, { ...BETTER_AUTH_SHAPE, logoSrc: 'https://cdn.test/logo.png' });

      expect(html).toContain('https://cdn.test/logo.png');
      expect(html).toContain('<img');
    });
  }

  it('escapes the link rather than interpolating it raw', () => {
    // Every interpolation is `<%= %>`; a `<%- %>` would let a crafted link break out of the href.
    const html = render('password-reset-en', { ...BETTER_AUTH_SHAPE, link: '" onmouseover="alert(1)' });

    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('&#34;');
  });
});

describe('email-verification templates', () => {
  // What sendVerificationEmail() passes.
  const shape = { appName: 'Acme', expiresIn: '24 hours', link: 'https://app.test/verify?token=x', name: 'V' };

  for (const locale of ['de', 'en']) {
    it(`the ${locale} template renders with the caller shape`, () => {
      expect(render(`email-verification-${locale}`, shape)).toContain(shape.link);
    });
  }
});
