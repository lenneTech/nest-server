/**
 * RFC 8707 audience binding of the MCP OAuth tokens (12.10.0).
 *
 * The authorization server issues tokens for `/ai/mcp` and — since `createMcpTokenVerifier()` — for a project's own
 * `@nestjs/mcp` endpoint. A token issued for one must not be accepted at the other, so `resource` is honoured at
 * `/authorize` and `/token`, bound into the code, the refresh token and the access token, and checked where the token
 * is used. Tokens and refresh tokens from before 12.10.0 carry no audience: valid at `/ai/mcp` only.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { mountAiMcpOAuth } from '../../src/core/modules/ai/helpers/ai-mcp-oauth.helper';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { createMcpOAuthMemoryConnection } from '../helpers/mcp-oauth-memory-connection';

const SECRET = 'unit-mcp-audience-oauth-secret-0123456789abcdef';
const REDIRECT_URI = 'http://127.0.0.1:33419/callback';
const CODE_VERIFIER = 'mcp-audience-code-verifier-0123456789abcdef0123456789';
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');
const MCP_RESOURCE = 'https://api.example.com/ai/mcp';
const PROJECT_RESOURCE = 'https://api.example.com/mcp';
const USER = { id: 'user-audience', roles: [] as string[] };

function audienceOf(accessToken: string): string | undefined {
  return JSON.parse(Buffer.from(accessToken.split('.')[0], 'base64url').toString('utf8')).aud;
}

describe('MCP OAuth audience binding (RFC 8707)', () => {
  let svc: CoreAiMcpOAuthService;
  let server: express.Express;
  let clientId: string;
  let verifier: ReturnType<CoreAiMcpOAuthService['createMcpTokenVerifier']>;

  beforeEach(async () => {
    ConfigService.setConfig(
      { ai: { mcp: { oauth: true, oauthSecret: SECRET } }, baseUrl: 'https://api.example.com', env: 'production' } as any,
      { reInit: true, warn: false },
    );
    const connection = createMcpOAuthMemoryConnection();
    await connection.db.collection('users').insertOne({ _id: USER.id, roles: USER.roles } as any);
    svc = new CoreAiMcpOAuthService(connection as any);
    server = express();
    await mountAiMcpOAuth({ get: () => svc, use: (...args: any[]) => server.use(...args) });
    verifier = svc.createMcpTokenVerifier({ resource: PROJECT_RESOURCE });
    const registered = await request(server)
      .post('/register')
      .send({ client_name: 'Audience client', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' });
    clientId = registered.body.client_id;
  });

  afterEach(() => {
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });

  const token = (body: Record<string, string>) =>
    request(server)
      .post('/token')
      .type('form')
      .send({ client_id: clientId, ...body });

  const exchange = async (resource?: string, codeResource?: string) => {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    await svc.saveAuthorizationCode(code, {
      clientId,
      codeChallenge: CODE_CHALLENGE,
      ...(codeResource ? { resource: codeResource } : {}),
      userId: USER.id,
    });
    return token({
      code,
      code_verifier: CODE_VERIFIER,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      ...(resource ? { resource } : {}),
    });
  };

  /**
   * @regression   12.10.0 — the authorization server issued tokens without an audience, so a token a client obtained
   *   for one MCP endpoint of the application was accepted at the other. The resource a client names must be one this
   *   server serves; any other is `invalid_target`.
   * @seen-failing Accept any absolute URL in resolveRequestedResource() in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation
   *   `mcp-oauth-unknown-resource-issued` in tests/regression-mutations.json. Throwing the refusal into the SDK's
   *   redirect path instead of answering it is mutation `mcp-authorize-invalid-target-redirects` (review).
   */
  it('refuses a resource this server does not serve, at /authorize and /token', async () => {
    const authorize = await request(server).get('/authorize').query({
      client_id: clientId,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT_URI,
      resource: 'https://evil.example.com/mcp',
      response_type: 'code',
      state: 's1',
    });
    // Answered here — never sent to the client's self-registered redirect URI, which would make /authorize an open
    // redirect for anyone with one link (RFC 9700 §4.11.2)
    expect(authorize.status).toBe(400);
    expect(authorize.headers.location).toBeUndefined();
    expect(authorize.body.error).toBe('invalid_target');

    const tokenResponse = await exchange('https://evil.example.com/mcp');
    expect(tokenResponse.status).toBe(400);
    expect(tokenResponse.body.error).toBe('invalid_target');
  });

  /**
   * @regression   12.10.0 — `/ai/mcp` accepted every token of this server, also one issued for a project's
   *   `@nestjs/mcp` endpoint: a token is valid only for the resource it was issued for.
   * @seen-failing Accept every audience in CoreAiMcpOAuthService.acceptsAudienceAtMcp() in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation
   *   `mcp-token-audience-ignored-at-mcp` in tests/regression-mutations.json.
   */
  it('binds the code to the requested resource; the token works there and nowhere else', async () => {
    const response = await exchange(PROJECT_RESOURCE, PROJECT_RESOURCE);
    expect(response.status).toBe(200);
    const accessToken: string = response.body.access_token;
    expect(audienceOf(accessToken)).toBe(PROJECT_RESOURCE);
    await expect(verifier.verifyAccessToken(accessToken)).resolves.not.toBeNull();
    expect(svc.acceptsAudienceAtMcp(svc.verifyAccessToken(accessToken))).toBe(false);

    // A code bound to the project endpoint cannot be exchanged for /ai/mcp
    const crossed = await exchange(MCP_RESOURCE, PROJECT_RESOURCE);
    expect(crossed.status).toBe(400);
    expect(crossed.body.error).toBe('invalid_target');
  });

  it('binds a client that names no resource to /ai/mcp — never to the project endpoint', async () => {
    const response = await exchange();
    expect(response.status).toBe(200);
    const accessToken: string = response.body.access_token;
    expect(audienceOf(accessToken)).toBe(MCP_RESOURCE);
    expect(svc.acceptsAudienceAtMcp(svc.verifyAccessToken(accessToken))).toBe(true);
    await expect(verifier.verifyAccessToken(accessToken)).resolves.toBeNull();
  });

  /**
   * @regression   12.10.0 — a refresh token must keep issuing tokens for the resource its grant was bound to: a refresh
   *   for another resource would turn one endpoint's grant into a token for the other.
   * @seen-failing Drop the resource from the rotated refresh token in CoreAiMcpOAuthService.rotateRefreshToken() in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation
   *   `mcp-refresh-resource-not-bound` in tests/regression-mutations.json.
   */
  it('keeps a refresh token bound to its resource, and refuses another one without spending the token', async () => {
    const first = await exchange(PROJECT_RESOURCE, PROJECT_RESOURCE);
    const refreshToken: string = first.body.refresh_token;

    const crossed = await token({ grant_type: 'refresh_token', refresh_token: refreshToken, resource: MCP_RESOURCE });
    expect(crossed.status).toBe(400);
    expect(crossed.body.error).toBe('invalid_target');

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    expect(refreshed.status).toBe(200);
    expect(audienceOf(refreshed.body.access_token)).toBe(PROJECT_RESOURCE);

    const again = await token({ grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token });
    expect(again.status).toBe(200);
    expect(audienceOf(again.body.access_token)).toBe(PROJECT_RESOURCE);
  });

  /**
   * @regression   12.10.0 — tokens and refresh tokens issued before 12.10.0 carry no audience. They stay valid where
   *   they were valid (`/ai/mcp`) and never reach another resource.
   * @seen-failing Accept a token without audience in CoreAiMcpOAuthService.acceptsAudience() in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation
   *   `mcp-verifier-accepts-legacy-token` in tests/regression-mutations.json.
   */
  it('accepts tokens from before 12.10.0 at /ai/mcp only', async () => {
    const legacyAccess = svc.signAccessToken(USER.id, clientId, 3600);
    expect(audienceOf(legacyAccess)).toBeUndefined();
    expect(svc.acceptsAudienceAtMcp(svc.verifyAccessToken(legacyAccess))).toBe(true);
    await expect(verifier.verifyAccessToken(legacyAccess)).resolves.toBeNull();

    const legacyRefresh = await svc.issueRefreshToken(USER.id, clientId);
    const crossed = await token({ grant_type: 'refresh_token', refresh_token: legacyRefresh, resource: PROJECT_RESOURCE });
    expect(crossed.status).toBe(400);
    expect(crossed.body.error).toBe('invalid_target');

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: legacyRefresh });
    expect(refreshed.status).toBe(200);
    expect(audienceOf(refreshed.body.access_token)).toBe(MCP_RESOURCE);
  });
});

describe('/ai/mcp checks the audience of an MCP OAuth token', () => {
  /**
   * @regression   12.10.0 — the controller resolved the user of any token this server signed; a token bound to a
   *   project's `@nestjs/mcp` endpoint must not open `/ai/mcp`.
   * @seen-failing Drop the acceptsAudienceAtMcp() condition from CoreAiMcpController.resolveUser() in
   *   src/core/modules/ai/core-ai-mcp.controller.ts — registered as mutation `mcp-controller-skips-audience` in
   *   tests/regression-mutations.json.
   */
  it('resolves no user for a token issued for another resource', async () => {
    ConfigService.setConfig(
      { ai: { mcp: { oauth: true, oauthSecret: SECRET } }, baseUrl: 'https://api.example.com', env: 'production' } as any,
      { reInit: true, warn: false },
    );
    const connection = createMcpOAuthMemoryConnection();
    await connection.db.collection('users').insertOne({ _id: USER.id, roles: USER.roles } as any);
    const svc = new CoreAiMcpOAuthService(connection as any);
    await mountAiMcpOAuth({ get: () => svc, use: () => undefined });
    const { CoreAiMcpController } = await import('../../src/core/modules/ai/core-ai-mcp.controller');
    const controller: any = new CoreAiMcpController({} as any, svc);
    const resolve = (accessToken: string) =>
      controller.resolveUser({ headers: { authorization: `Bearer ${accessToken}` } });

    await expect(resolve(svc.signAccessToken(USER.id, 'c1', 3600, PROJECT_RESOURCE))).resolves.toBeNull();
    await expect(resolve(svc.signAccessToken(USER.id, 'c1', 3600, MCP_RESOURCE))).resolves.toMatchObject({ id: USER.id });
    await expect(resolve(svc.signAccessToken(USER.id, 'c1', 3600))).resolves.toMatchObject({ id: USER.id });
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
    // The dynamic import of the controller transforms a large module graph: ~1.5 s alone, past the 5 s default
    // under a full-suite run.
  }, 30_000);
});

describe('the consent flow binds the code to the resource named at /authorize', () => {
  /** The hidden fields of the consent form, as the browser submits them */
  function formOf(html: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
      fields[name] = value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    return fields;
  }

  /**
   * @regression   12.10.0 (review) — the resource a client names at /authorize must reach the code the consent issues.
   *   Lost on the way, every MCP 2025-06-18 client (which names it at /authorize and /token) got `invalid_target` at
   *   /token, and no client could obtain a token for a project's `@nestjs/mcp` endpoint.
   * @seen-failing Leave `resource` out of the authorizeRequest.run() store in the provider's `authorize` in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation
   *   `mcp-authorize-resource-not-bound` in tests/regression-mutations.json.
   */
  it('issues a token for the resource of the consent, with and without resource at /token', async () => {
    ConfigService.setConfig(
      { ai: { mcp: { oauth: true, oauthSecret: SECRET } }, baseUrl: 'https://api.example.com', env: 'production' } as any,
      { reInit: true, warn: false },
    );
    const svc = new CoreAiMcpOAuthService(createMcpOAuthMemoryConnection() as any);
    const server = express();
    server.use((req: any, _res, next) => {
      req.user = { email: 'ada@example.com', id: USER.id, name: 'Ada', roles: [] };
      next();
    });
    await mountAiMcpOAuth({ get: () => svc, use: (...args: any[]) => server.use(...args) });
    svc.createMcpTokenVerifier({ resource: PROJECT_RESOURCE });
    const registered = await request(server)
      .post('/register')
      .send({ client_name: 'Consent client', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' });
    const clientId: string = registered.body.client_id;

    for (const tokenResource of [PROJECT_RESOURCE, undefined]) {
      const page = await request(server).get('/authorize').query({
        client_id: clientId,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT_URI,
        resource: PROJECT_RESOURCE,
        response_type: 'code',
        state: 's2',
      });
      expect(page.status).toBe(200);
      const allowed = await request(server)
        .post('/authorize')
        .type('form')
        .send({ ...formOf(page.text), lt_mcp_consent: 'approve' });
      expect(allowed.status).toBe(302);
      const code = new URL(allowed.headers.location).searchParams.get('code');
      expect(code).toBeTruthy();

      const issued = await request(server)
        .post('/token')
        .type('form')
        .send({
          client_id: clientId,
          code,
          code_verifier: CODE_VERIFIER,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
          ...(tokenResource ? { resource: tokenResource } : {}),
        });
      expect(issued.status).toBe(200);
      expect(audienceOf(issued.body.access_token)).toBe(PROJECT_RESOURCE);
    }
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });
});
