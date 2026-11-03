/**
 * `/authorize` must not send a browser to a redirect URI nobody has vouched for.
 *
 * Dynamic client registration (`/register`) stores whatever `redirect_uris` the registrant sends — that is how
 * claude.ai, ChatGPT, Cursor or Claude Code connect, and it has to stay open. The SDK's authorize handler answers an
 * error that arises after the client check (a missing `code_challenge`, a wrong `response_type`) with a 302 to that
 * URI, so a client registered with `https://phish.example.net/…` turned `/authorize` into an open redirect on the API's
 * own domain: one crafted link, no sign-in needed (RFC 9700 §4.11.2). Such an error is now answered directly, like the
 * SDK's own errors before the client check. A redirect follows only what the provider does — the signed-in user's
 * Allow or Deny on the consent page, which carries a CSRF token, and refusals the provider raises itself.
 *
 * Asserted over HTTP on the router `mountAiMcpOAuth()` mounts: the redirect is decided by the SDK's handler, which a
 * test against the provider alone cannot see.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { mountAiMcpOAuth } from '../../src/core/modules/ai/helpers/ai-mcp-oauth.helper';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { createMcpOAuthMemoryConnection } from '../helpers/mcp-oauth-memory-connection';

const FOREIGN_URI = 'https://phish.example.net/landing';
const LOOPBACK_URI = 'http://127.0.0.1:33418/callback';
const CODE_CHALLENGE = createHash('sha256')
  .update('mcp-oauth-error-redirect-verifier-0123456789abcdef')
  .digest('base64url');
const USER = { email: 'ada@example.com', id: 'user-ada', name: 'Ada', roles: [] };

/** Mounts the OAuth router on a real express app; `user` stands in for whoever is signed in. */
async function mountOAuth(user?: unknown) {
  const svc = new CoreAiMcpOAuthService(createMcpOAuthMemoryConnection() as any);
  const server = express();
  if (user) {
    server.use((req: any, _res, next) => {
      req.user = user;
      next();
    });
  }
  await mountAiMcpOAuth({ get: () => svc, use: (...args: any[]) => server.use(...args) });

  /** Registers a public client the way an MCP client does — any redirect URI is accepted */
  const register = async (redirectUri: string): Promise<string> => {
    const response = await request(server)
      .post('/register')
      .send({ client_name: 'Registered client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' });
    expect(response.status).toBe(201);
    return response.body.client_id;
  };

  /** The authorization parameters of a well-formed request */
  const params = (clientId: string, redirectUri: string) => ({
    client_id: clientId,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    response_type: 'code',
    state: 'state-1',
  });

  return { params, register, server };
}

/** The hidden fields of the consent form, as the browser submits them */
function formOf(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[name] = value
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return fields;
}

describe('MCP OAuth /authorize — no redirect to a registered URI before the user decided', () => {
  beforeEach(() => {
    ConfigService.setConfig(
      {
        ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-error-redirect-secret-32chars' } },
        baseUrl: 'https://api.example.com',
        env: 'production',
      } as any,
      { reInit: true, warn: false },
    );
  });

  /**
   * @regression   12.3.0 — the SDK sent an error after the client check to the client's registered redirect URI, so a
   *   self-registered client made `/authorize?client_id=…` (one parameter missing) an open redirect on this domain.
   * @seen-failing Mount the OAuth router without the guard in mountRouter()
   *   (src/core/modules/ai/helpers/ai-mcp-oauth.helper.ts) — registered as mutation
   *   `mcp-oauth-error-redirect-unguarded` in tests/regression-mutations.json.
   */
  it('answers a malformed request of a self-registered client with 400 instead of redirecting to its URI', async () => {
    const { params, register, server } = await mountOAuth();
    const clientId = await register(FOREIGN_URI);
    const { code_challenge: _dropped, ...withoutChallenge } = params(clientId, FOREIGN_URI);

    for (const query of [withoutChallenge, { ...params(clientId, FOREIGN_URI), response_type: 'token' }]) {
      const response = await request(server).get('/authorize').query(query);
      expect(response.status).toBe(400);
      expect(response.headers.location).toBeUndefined();
      expect(response.body.error).toBe('invalid_request');
    }
    // The same over POST, and with the path spelled the way Express still routes it
    const posted = await request(server).post('/authorize').type('form').send(withoutChallenge);
    expect(posted.status).toBe(400);
    expect(posted.headers.location).toBeUndefined();
    const upper = await request(server).get('/Authorize').query(withoutChallenge);
    expect(upper.headers.location).toBeUndefined();
  });

  it('keeps registration open and a well-formed request working, for loopback and https clients alike', async () => {
    const { params, register, server } = await mountOAuth();
    for (const uri of [LOOPBACK_URI, FOREIGN_URI]) {
      const clientId = await register(uri);
      const response = await request(server).get('/authorize').query(params(clientId, uri));
      // Nobody signed in: the sign-in view, never a redirect
      expect(response.status).toBe(200);
      expect(response.headers.location).toBeUndefined();
    }
  });

  it("redirects on the signed-in user's own decision: Deny with the consent form's token", async () => {
    const { params, register, server } = await mountOAuth(USER);
    const clientId = await register(LOOPBACK_URI);
    const page = await request(server).get('/authorize').query(params(clientId, LOOPBACK_URI));
    expect(page.status).toBe(200);
    const denied = await request(server)
      .post('/authorize')
      .type('form')
      .send({ ...formOf(page.text), lt_mcp_consent: 'deny' });
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.location);
    expect(location.origin + location.pathname).toBe(LOOPBACK_URI);
    expect(location.searchParams.get('error')).toBe('access_denied');
  });

  /**
   * @regression   12.3.0 — Deny was honoured without the consent form's CSRF token, so a cross-site POST in a
   *   deployment whose session cookie is `SameSite=None` sent a signed-in user to the client's registered URI.
   * @seen-failing Deny without checking the consent token in authorizeConsent()
   *   (src/core/modules/ai/services/core-ai-mcp-oauth.service.ts) — registered as mutation
   *   `mcp-oauth-deny-without-consent-token` in tests/regression-mutations.json.
   */
  it('shows the form again for a Deny without a valid consent token, and redirects nowhere', async () => {
    const { params, register, server } = await mountOAuth(USER);
    const clientId = await register(FOREIGN_URI);
    for (const token of [undefined, 'forged-token']) {
      const response = await request(server)
        .post('/authorize')
        .type('form')
        .send({ ...params(clientId, FOREIGN_URI), lt_mcp_consent: 'deny', ...(token ? { lt_mcp_csrf: token } : {}) });
      expect(response.status).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.text).toContain('lt_mcp_csrf');
    }
  });
});
