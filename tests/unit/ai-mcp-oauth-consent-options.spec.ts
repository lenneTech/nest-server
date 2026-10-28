/**
 * `renderMcpOAuthConsentPage(view, options)` — project adjustments of the built-in consent page.
 *
 * A project may change the wording (e.g. its form of address) and the look of the page, but never
 * its markup, scripts or security headers: those are what make the page safe, and a project that
 * had to copy them to change a sentence would stop receiving their fixes. The cases pin that texts
 * are merged per locale over the built-in ones, that styles are appended, and that a replaced text
 * still goes through the same escaping as the built-in one.
 */
import { describe, expect, it } from 'vitest';

// Imported from the package root on purpose: the helper is part of the public API.
import { IMcpOAuthConsentView, renderMcpOAuthConsentPage } from '../../src';

/** Consent view of a signed-in user with a client whose name tries to inject markup. */
function view(overrides: Partial<IMcpOAuthConsentView> = {}): IMcpOAuthConsentView {
  return {
    appHost: 'example.test',
    client: { id: 'c1', name: '<img src=x onerror=alert(1)>' },
    csrfToken: 'token',
    locale: 'de',
    nonce: 'nonce',
    oauthParams: { client_id: 'c1' },
    redirect: { host: '127.0.0.1:3000', loopback: true },
    user: { email: 'admin@test.com' },
    ...overrides,
  };
}

describe('renderMcpOAuthConsentPage — options', () => {
  it('keeps the built-in texts and styles without options', () => {
    const html = renderMcpOAuthConsentPage(view());

    expect(html).toContain('in deinem Namen');
    expect(html).not.toContain('.extra{');
  });

  it('merges replacement texts over the built-in ones and appends styles', () => {
    const html = renderMcpOAuthConsentPage(view(), {
      styles: '.extra{color:red}',
      texts: { de: { intro: '{client} möchte in Deinem Namen auf {app} zugreifen.' } },
    });

    expect(html).toContain('in Deinem Namen');
    // Texts not replaced stay the built-in ones.
    expect(html).toContain('Zulassen');
    // Appended after the built-in styles, inside the same nonce'd style element.
    expect(html).toContain('.extra{color:red}</style>');
  });

  it('still escapes the client name inside a replaced text', () => {
    const html = renderMcpOAuthConsentPage(view(), { texts: { de: { intro: '{client} fragt.' } } });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('leaves the other locale untouched', () => {
    const html = renderMcpOAuthConsentPage(view({ locale: 'en' }), { texts: { de: { allow: 'Erlauben' } } });

    expect(html).toContain('>Allow<');
    expect(html).not.toContain('Erlauben');
  });
});
