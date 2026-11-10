/**
 * `CoreAiMcpOAuthService.sendConsentNotice()` — a project's own answer on the consent route.
 *
 * A project that refuses some accounts before the consent form (e.g. only administrators may connect MCP clients)
 * needs a page with the same security headers as the consent page: a nonce'd CSP, `frame-ancestors 'none'`,
 * `X-Frame-Options`, `no-store`. Those headers are internal on purpose (a project that copied them would stop
 * receiving their fixes), so the framework applies them. Asserted over HTTP on the router `mountAiMcpOAuth()` mounts,
 * with a subclass shaped like a project's override.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

// Imported from the package root on purpose: the notice renderer and its types are part of the public API.
import * as publicApi from '../../src';
import { IMcpOAuthConsentNotice, renderMcpOAuthConsentNoticePage } from '../../src';
import { ConfigService } from '../../src/core/common/services/config.service';
import { mountAiMcpOAuth } from '../../src/core/modules/ai/helpers/ai-mcp-oauth.helper';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { createMcpOAuthMemoryConnection } from '../helpers/mcp-oauth-memory-connection';

const REDIRECT_URI = 'http://127.0.0.1:33418/callback';
const CODE_CHALLENGE = createHash('sha256')
  .update('mcp-oauth-consent-notice-verifier-0123456789abcdef')
  .digest('base64url');
const ADMIN = { email: 'admin@example.com', id: 'user-admin', name: 'Admin', roles: ['admin'] };
const MEMBER = { email: 'member@example.com', id: 'user-member', name: 'Member', roles: [] };

/**
 * Shaped like a project's override that answers with a notice of its own before the framework's consent step. It keys on
 * the role only to tell the two cases apart; who may use MCP at all belongs in `ai.mcp.roles` / `mayUseMcp()`
 * (tests/unit/ai-mcp-access.spec.ts), which `/ai/mcp` and `/token` check too.
 */
class AdminsOnlyOAuthService extends CoreAiMcpOAuthService {
  notice: Partial<IMcpOAuthConsentNotice> = {};

  protected override async authorizeConsent(client: any, params: any, res: any): Promise<void> {
    const user = res.req?.user;
    if (user && !user.roles?.includes('admin')) {
      return this.sendConsentNotice(res, {
        message: ['Nur Administratoren dürfen MCP-Clients verbinden.', 'Melde dich mit einem anderen Konto an.'],
        title: 'Zugriff nicht möglich',
        ...this.notice,
      });
    }
    return super.authorizeConsent(client, params, res);
  }
}

async function mountOAuth(user?: unknown) {
  const svc = new AdminsOnlyOAuthService(createMcpOAuthMemoryConnection() as any);
  const server = express();
  if (user) {
    server.use((req: any, _res, next) => {
      req.user = user;
      next();
    });
  }
  await mountAiMcpOAuth({ get: () => svc, use: (...args: any[]) => server.use(...args) });
  const registered = await request(server)
    .post('/register')
    .send({ client_name: 'Registered client', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' });
  expect(registered.status).toBe(201);
  const authorize = () =>
    request(server).get('/authorize').query({
      client_id: registered.body.client_id,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'state-1',
    });
  return { authorize, svc };
}

/** The nonce of the response's CSP */
function cspNonce(csp: string | undefined): string | undefined {
  return csp?.match(/script-src 'nonce-([^']+)'/)?.[1];
}

describe('MCP OAuth consent notice — sendConsentNotice()', () => {
  beforeEach(() => {
    ConfigService.setConfig(
      {
        ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-consent-notice-secret-32chars' } },
        baseUrl: 'https://api.example.com',
        env: 'production',
      } as any,
      { reInit: true, warn: false },
    );
  });

  it("answers with the project's notice and the consent page's security headers", async () => {
    const { authorize } = await mountOAuth(MEMBER);
    const response = await authorize();

    expect(response.status).toBe(403);
    expect(response.headers.location).toBeUndefined();
    const csp = response.headers['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-type']).toContain('text/html');

    // The page's style element carries the nonce of THIS response's CSP, or the browser would drop it
    const nonce = cspNonce(csp);
    expect(nonce).toBeTruthy();
    expect(response.text).toContain(`<style nonce="${nonce}">`);

    expect(response.text).toContain('<h1>Zugriff nicht möglich</h1>');
    expect(response.text).toContain('<p>Nur Administratoren dürfen MCP-Clients verbinden.</p>');
    expect(response.text).toContain('<p>Melde dich mit einem anderen Konto an.</p>');
    // Nothing on it can issue a code
    expect(response.text).not.toContain('<form');
    expect(response.text).not.toContain('lt_mcp_csrf');
    expect(response.text).not.toContain('lt-mcp-allow');
  });

  it('draws a fresh nonce per response', async () => {
    const { authorize } = await mountOAuth(MEMBER);
    const first = cspNonce((await authorize()).headers['content-security-policy']);
    const second = cspNonce((await authorize()).headers['content-security-policy']);

    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it('leaves the consent form to the framework for accounts the project lets through', async () => {
    const { authorize } = await mountOAuth(ADMIN);
    const response = await authorize();

    expect(response.status).toBe(200);
    expect(response.text).toContain('lt-mcp-allow');
  });

  it('honours a status between 400 and 599 and falls back to 403 otherwise', async () => {
    const { authorize, svc } = await mountOAuth(MEMBER);
    svc.notice = { status: 401 };
    expect((await authorize()).status).toBe(401);

    for (const status of [200, 302, 600, 403.5, Number.NaN]) {
      svc.notice = { status };
      expect((await authorize()).status).toBe(403);
    }
  });

  it('escapes title and message', async () => {
    const { authorize, svc } = await mountOAuth(MEMBER);
    svc.notice = { message: '<img src=x onerror=alert(1)>', title: '<script>alert(1)</script>' };
    const response = await authorize();

    expect(response.text).not.toContain('<img src=x');
    expect(response.text).not.toContain('<script>alert(1)');
    expect(response.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('takes the locale from the notice, else from Accept-Language', async () => {
    const { authorize, svc } = await mountOAuth(MEMBER);
    svc.notice = { locale: 'de' };
    expect((await authorize()).text).toContain('<html lang="de">');

    svc.notice = {};
    const english = await authorize().set('accept-language', 'en-US');
    expect(english.text).toContain('<html lang="en">');
    const german = await authorize().set('accept-language', 'de-DE,de;q=0.9');
    expect(german.text).toContain('<html lang="de">');
  });

  it('renders a link only to an http(s) URL or a path on this origin', async () => {
    const { authorize, svc } = await mountOAuth(MEMBER);
    for (const href of ['https://app.example.com/start', '/start']) {
      svc.notice = { link: { href, label: 'Zur Anwendung' } };
      expect((await authorize()).text).toContain(`<a href="${href}">Zur Anwendung</a>`);
    }
    for (const href of [
      'javascript:alert(1)',
      '//evil.example.net',
      '/\\evil.example.net',
      '/\t/evil.example.net',
      'data:text/html,x',
      '',
    ]) {
      svc.notice = { link: { href, label: 'Zur Anwendung' } };
      expect((await authorize()).text).not.toContain('Zur Anwendung');
    }
  });

  it('exports the notice renderer, still not the security headers', () => {
    expect(Object.keys(publicApi)).toEqual(expect.arrayContaining(['renderMcpOAuthConsentNoticePage']));
    expect(Object.keys(publicApi)).not.toContain('mcpOAuthConsentHeaders');
    expect(Object.keys(publicApi)).not.toContain('consentNoticeLinkHref');
  });
});

describe('renderMcpOAuthConsentNoticePage', () => {
  const view = {
    appHost: 'example.test',
    authBasePath: '/iam',
    locale: 'de' as const,
    message: ['Kein Zugriff.'],
    nonce: 'nonce',
    title: 'Zugriff nicht möglich',
    user: { email: 'member@example.com' },
  };

  it('shows the signed-in account with "use another account" and its script', () => {
    const html = renderMcpOAuthConsentNoticePage(view);

    expect(html).toContain('Angemeldet als <strong>member@example.com</strong>');
    expect(html).toContain('data-sign-out="/iam/sign-out"');
    expect(html).toContain('<script nonce="nonce">');
  });

  it('offers no other account and runs no script without Better-Auth', () => {
    const html = renderMcpOAuthConsentNoticePage({ ...view, authBasePath: undefined });

    expect(html).toContain('Angemeldet als');
    expect(html).not.toContain('lt-mcp-switch');
    expect(html).not.toContain('<script');
  });

  it('takes texts and styles like the consent page, styles confined to their element', () => {
    const html = renderMcpOAuthConsentNoticePage(view, {
      styles: '.card{border-color:red}</style><form action="https://evil.test">',
      texts: { de: { switchAccount: 'Mit anderem Konto anmelden' } },
    });

    expect(html).toContain('Mit anderem Konto anmelden');
    expect(html).toContain('.card{border-color:red}');
    expect(html).not.toContain('<form action="https://evil.test"');
    expect(html.match(/<\/style>/g)).toHaveLength(1);
  });
});
