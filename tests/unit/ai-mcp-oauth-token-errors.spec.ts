/**
 * What the MCP OAuth endpoints answer when they refuse a grant.
 *
 * The SDK's handlers decide the answer with `instanceof OAuthError`: every other error becomes
 * `500 server_error`. The provider used to refuse with a plain `Error('invalid_grant')`, so an
 * unknown, rotated or foreign refresh token was answered with a 500. That is more than a wrong
 * status. An MCP client discards its stored tokens only on `invalid_grant`; on a server error
 * Claude Code kept the dead token, retried the refresh on every start, and never marked the
 * server as needing a new sign-in. The server ended in CONNECT_TIMEOUT instead.
 *
 * Asserted over HTTP, on the real router `mountAiMcpOAuth()` mounts: status and `error` are what
 * the client reads, and they come from the SDK's `instanceof` check, which a test against the
 * provider alone cannot see. The token endpoint takes form-encoded bodies only (RFC 6749 §4.1.3),
 * hence `.type('form')` rather than TestHelper, which sends JSON.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { ApiTokenKind } from '../../src/core/modules/api-token/core-api-token.constants';
import { attachApiTokenContext } from '../../src/core/modules/api-token/core-api-token.helpers';
import { mountAiMcpOAuth } from '../../src/core/modules/ai/helpers/ai-mcp-oauth.helper';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { createMcpOAuthMemoryConnection } from '../helpers/mcp-oauth-memory-connection';

const REDIRECT_URI = 'https://app.example.com/callback';
const CODE_VERIFIER = 'mcp-oauth-token-errors-code-verifier-0123456789abcdef';
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');

/** Mounts the OAuth router on a real express app; `user` stands in for whatever authenticated the request. */
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

  /** Registers a public client the way an MCP client does (dynamic client registration). */
  const registerClient = async (): Promise<string> => {
    const response = await request(server)
      .post('/register')
      .send({ client_name: 'MCP test client', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' });
    expect(response.status).toBe(201);
    return response.body.client_id;
  };

  const postToken = (form: Record<string, string>) => request(server).post('/token').type('form').send(form);

  return { postToken, registerClient, server, svc };
}

describe('MCP OAuth token endpoint — refusals reach the client as OAuth errors', () => {
  beforeEach(() => {
    ConfigService.setConfig(
      {
        ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-token-errors-secret-32chars' } },
        baseUrl: 'https://api.example.com',
        env: 'production',
      } as any,
      { reInit: true, warn: false },
    );
  });

  /**
   * @regression   11.42.16 and earlier — exchangeRefreshToken() refused an unknown refresh token
   *   with a plain `Error('invalid_grant')`, which the SDK's token handler answers as
   *   `500 server_error`. MCP clients discard their tokens only on `invalid_grant`, so they kept
   *   the dead token and retried instead of asking the user to sign in again.
   * @seen-failing Registered as `mcp-oauth-refresh-refusal-plain-error` in
   *   tests/regression-mutations.json — throwing the plain Error again turns this red (500).
   */
  it('answers an unknown refresh token with 400 invalid_grant, not 500', async () => {
    const { postToken, registerClient } = await mountOAuth();
    const clientId = await registerClient();

    const response = await postToken({ client_id: clientId, grant_type: 'refresh_token', refresh_token: 'unknown' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_grant');
  });

  /**
   * @regression   Same defect, the case a client actually hits: the refresh token it stored was
   *   rotated away (refresh tokens are single-use here).
   * @seen-failing Registered as `mcp-oauth-refresh-refusal-plain-error` in
   *   tests/regression-mutations.json.
   */
  it('issues new tokens for a valid refresh token, and answers its reuse with 400 invalid_grant', async () => {
    const { postToken, registerClient, svc } = await mountOAuth();
    const clientId = await registerClient();
    const refreshToken = await svc.issueRefreshToken('user-1', clientId);

    const first = await postToken({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ token_type: 'Bearer' });
    expect(first.body.access_token).toBeTruthy();
    expect(first.body.refresh_token).toBeTruthy();
    expect(first.body.refresh_token).not.toBe(refreshToken);

    const reuse = await postToken({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
  });

  /**
   * @regression   Same defect for a refresh token presented by a client it was not issued to.
   * @seen-failing Registered as `mcp-oauth-refresh-refusal-plain-error` in
   *   tests/regression-mutations.json.
   */
  it('answers a refresh token issued to another client with 400 invalid_grant and leaves it valid for its owner', async () => {
    const { postToken, registerClient, svc } = await mountOAuth();
    const ownerId = await registerClient();
    const otherId = await registerClient();
    const refreshToken = await svc.issueRefreshToken('user-1', ownerId);

    const foreign = await postToken({ client_id: otherId, grant_type: 'refresh_token', refresh_token: refreshToken });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('invalid_grant');

    const owner = await postToken({ client_id: ownerId, grant_type: 'refresh_token', refresh_token: refreshToken });
    expect(owner.status).toBe(200);
  });

  /**
   * @regression   11.42.16 and earlier — exchangeAuthorizationCode() refused a code issued to
   *   another client with a plain `Error('invalid_grant')`, answered as `500 server_error`.
   * @seen-failing Registered as `mcp-oauth-code-refusal-plain-error` in
   *   tests/regression-mutations.json — throwing the plain Error again turns this red (500).
   */
  it('answers an authorization code issued to another client with 400 invalid_grant', async () => {
    const { postToken, registerClient, svc } = await mountOAuth();
    const ownerId = await registerClient();
    const otherId = await registerClient();
    await svc.saveAuthorizationCode('code-foreign', { clientId: ownerId, codeChallenge: CODE_CHALLENGE, userId: 'u1' });
    await svc.saveAuthorizationCode('code-own', { clientId: ownerId, codeChallenge: CODE_CHALLENGE, userId: 'u1' });

    // The PKCE verifier matches, so it is the provider — not the SDK's PKCE check — that refuses.
    const foreign = await postToken({
      client_id: otherId,
      code: 'code-foreign',
      code_verifier: CODE_VERIFIER,
      grant_type: 'authorization_code',
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('invalid_grant');

    const own = await postToken({
      client_id: ownerId,
      code: 'code-own',
      code_verifier: CODE_VERIFIER,
      grant_type: 'authorization_code',
    });
    expect(own.status).toBe(200);
    expect(own.body.access_token).toBeTruthy();
  });

  /**
   * @regression   11.42.16 and earlier — exchangeAuthorizationCode() deleted the code BEFORE it compared
   *   the client, so another client presenting it (with the verifier) burned the owner's code.
   * @seen-failing Registered as `mcp-oauth-code-burned-by-foreign-client` in
   *   tests/regression-mutations.json — consuming by code alone turns this red.
   */
  it('leaves a code another client presented for the client it was issued to', async () => {
    const { postToken, registerClient, svc } = await mountOAuth();
    const ownerId = await registerClient();
    const otherId = await registerClient();
    await svc.saveAuthorizationCode('code-shared', { clientId: ownerId, codeChallenge: CODE_CHALLENGE, userId: 'u1' });
    const form = { code: 'code-shared', code_verifier: CODE_VERIFIER, grant_type: 'authorization_code' };

    const foreign = await postToken({ ...form, client_id: otherId });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('invalid_grant');

    const owner = await postToken({ ...form, client_id: ownerId });
    expect(owner.status).toBe(200);
    expect(owner.body.access_token).toBeTruthy();
  });
});

describe('MCP OAuth authorize endpoint — an API token is refused as access_denied', () => {
  beforeEach(() => {
    ConfigService.setConfig(
      {
        ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-token-errors-secret-32chars' } },
        baseUrl: 'https://api.example.com',
        env: 'production',
      } as any,
      { reInit: true, warn: false },
    );
  });

  const userWithToken = () =>
    attachApiTokenContext(
      { hasRole: () => false, id: '65f000000000000000000009', roles: [] },
      {
        kind: ApiTokenKind.USER,
        name: 'cli',
        publicId: 'b'.repeat(24),
        scopes: ['read'],
        tokenId: '65f000000000000000000002',
        userId: '65f000000000000000000009',
      },
    );

  /** Starts an authorization request as `user`. */
  async function startAuthorization(user: unknown) {
    const { registerClient, server } = await mountOAuth(user);
    const clientId = await registerClient();
    return request(server).get('/authorize').query({
      client_id: clientId,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'state-1',
    });
  }

  /** Starts an authorization request and returns the error the client is redirected back with. */
  async function authorizeAs(user: unknown) {
    const response = await startAuthorization(user);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('state-1');
    return location.searchParams.get('error');
  }

  /**
   * @regression   11.42.16 and earlier — the API-token refusal in authorize() was a plain Error,
   *   so the client was redirected back with `error=server_error` instead of `access_denied`.
   * @seen-failing Registered as `mcp-oauth-consent-refusal-plain-error` in
   *   tests/regression-mutations.json — throwing the plain Error again turns this red.
   */
  it('redirects an API-token request back with error=access_denied', async () => {
    expect(await authorizeAs(userWithToken())).toBe('access_denied');
  });

  it('hands a session user on to the consent page instead of refusing it', async () => {
    // The pair to the case above: the same request with a session user is answered with the consent
    // view (its CSRF field exists only there), so the access_denied there comes from the API-token check.
    const response = await startAuthorization({ email: 'u1@example.com', id: 'u1', roles: [] });
    expect(response.status).toBe(200);
    expect(response.text).toContain('lt_mcp_csrf');
  });
});
