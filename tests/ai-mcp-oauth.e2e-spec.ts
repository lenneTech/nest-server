/**
 * MCP OAuth with the built-in consent page, on the assembled stack.
 *
 * The unit specs drive the consent page with a stand-in for the Better-Auth middleware. This one
 * boots a real IAM-only `CoreModule` with `ai.mcp.oauth: true` and walks the flow the way a browser
 * and an MCP client do: Better-Auth sign-in sets the session cookie, `/authorize` recognizes it and
 * shows the consent form, Allow issues the code, `/token` turns it into tokens, and the MCP
 * endpoint accepts the access token for a session with the user's tools.
 *
 * What only this level shows: that the session cookie Better-Auth sets reaches the OAuth router
 * (mounted behind the Nest middleware), that the user on the request is the framework user whose
 * id the MCP controller loads again, and that the endpoints exist on a real `CoreModule` at all.
 */
import { NestExpressApplication } from '@nestjs/platform-express';
import { Db, MongoClient } from 'mongodb';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthModule, TestHelper } from '../src';
import envConfig from '../src/config.env';
import type { DataStore } from '../src/core/common/persistence/data-store.interface';
import { getStoreToken } from '../src/core/common/persistence/persistence.tokens';
import { ConfigService } from '../src/core/common/services/config.service';
import { apiTokenIamConfig, bootApiTokenIamApp } from './helpers/api-token-e2e.helpers';

const REDIRECT_URI = 'http://127.0.0.1:33418/callback';
const CODE_VERIFIER = 'mcp-oauth-e2e-code-verifier-0123456789abcdefghijklmnop';
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');

/** The hidden fields of a rendered consent form, HTML entities decoded. */
function formOf(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[name] = value
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return fields;
}

describe('MCP OAuth — built-in consent on the assembled stack (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let mongo: MongoClient;
  let previousConfig: any;
  let helper: TestHelper;
  const email = `mcp-oauth-${Date.now()}@test.com`;
  const password = 'McpOAuthPassword123!';

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    const config = apiTokenIamConfig('mcp-oauth', {
      ai: {
        ...(envConfig as any).ai,
        mcp: { oauth: true, oauthSecret: 'e2e-mcp-oauth-signing-secret-of-32-plus-chars' },
      },
    });
    app = await bootApiTokenIamApp(config);
    mongo = await MongoClient.connect(config.mongoose.uri);
    db = mongo.db();
    helper = new TestHelper(app);

    await helper.rest('/iam/sign-up/email', {
      method: 'POST',
      payload: { email, name: 'MCP OAuth', password, termsAndPrivacyAccepted: true },
      statusCode: 201,
    });
    await db.collection('users').updateOne({ email }, { $set: { emailVerified: true, verified: true } });
    await db.collection('iam_user').updateOne({ email }, { $set: { emailVerified: true } });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.close();
    CoreBetterAuthModule.reset();
    if (previousConfig) {
      ConfigService.setConfig(previousConfig, { reInit: true, warn: false });
    }
  });

  /** Registers a client the way an MCP client does and returns the parameters of its authorization request. */
  async function authorizationRequest() {
    const registered = await request(app.getHttpServer())
      .post('/register')
      .send({ client_name: 'Claude Code', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' });
    expect(registered.status).toBe(201);
    const clientId: string = registered.body.client_id;
    return {
      clientId,
      params: {
        client_id: clientId,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        state: 'e2e-state',
      },
    };
  }

  it('shows the sign-in view to a browser without a session', async () => {
    const { params } = await authorizationRequest();

    const page = await request(app.getHttpServer()).get('/authorize').query(params);

    expect(page.status).toBe(200);
    expect(page.text).toContain('id="lt-mcp-signin"');
    expect(page.text).toContain('data-auth-base="/iam"');
    expect(page.text).not.toContain('lt_mcp_csrf');
  });

  it('signs in with the Better-Auth session cookie, asks for consent, and connects the MCP client', async () => {
    const browser = request.agent(app.getHttpServer());
    // What the sign-in view's script does: Better-Auth sign-in on this origin, then a reload.
    const signIn = await browser.post('/iam/sign-in/email').send({ email, password });
    expect(signIn.status).toBe(200);

    const { clientId, params } = await authorizationRequest();
    const page = await browser.get('/authorize').query(params);
    expect(page.status).toBe(200);
    expect(page.text).toContain(email);
    expect(page.text).toContain('Claude Code');

    const approved = await browser
      .post('/authorize')
      .type('form')
      .send({ ...formOf(page.text), lt_mcp_consent: 'approve' });
    expect(approved.status).toBe(302);
    const redirect = new URL(approved.headers.location);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('state')).toBe('e2e-state');

    const tokens = await request(app.getHttpServer())
      .post('/token')
      .type('form')
      .send({
        client_id: clientId,
        code: redirect.searchParams.get('code')!,
        code_verifier: CODE_VERIFIER,
        grant_type: 'authorization_code',
      });
    expect(tokens.status).toBe(200);
    expect(tokens.body.refresh_token).toBeTruthy();

    // The MCP endpoint accepts the OAuth access token and opens a session as that user.
    const session = await helper.mcpSession({ token: tokens.body.access_token });
    expect(session.sessionId).toBeTruthy();
    expect(Array.isArray(await session.listTools())).toBe(true);

    // A refused refresh is an OAuth error the client acts on, not a server error.
    const reused = await request(app.getHttpServer())
      .post('/token')
      .type('form')
      .send({ client_id: clientId, grant_type: 'refresh_token', refresh_token: 'not-a-refresh-token' });
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe('invalid_grant');
  });

  /**
   * @regression   DEV-3832 (db-agnostic phase 4) — an authorization code was exchangeable for as long as it stayed in
   *   the store: MongoDB's TTL index removed it late or never, and a SQL table has no TTL at all.
   * @seen-failing Drop the age check in CoreAiMcpOAuthService.liveCode() in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation `mcp-oauth-expired-code-exchanged`
   *   in tests/regression-mutations.json.
   */
  it('refuses an authorization code older than ten minutes at the token endpoint, on the stored record', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.post('/iam/sign-in/email').send({ email, password }).expect(200);
    const { clientId, params } = await authorizationRequest();
    const page = await browser.get('/authorize').query(params);
    const approved = await browser
      .post('/authorize')
      .type('form')
      .send({ ...formOf(page.text), lt_mcp_consent: 'approve' });
    const code = new URL(approved.headers.location).searchParams.get('code')!;

    // Age the stored code past its ten minutes, as a code nobody swept — wherever it is stored (MongoDB or SQL)
    const codes = app.get<DataStore<any>>(getStoreToken('AiMcpOAuthCode'), { strict: false });
    const aged = await codes.updateOne({ code }, { $set: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    expect(aged).toMatchObject({ code });

    const tokens = await request(app.getHttpServer())
      .post('/token')
      .type('form')
      .send({ client_id: clientId, code, code_verifier: CODE_VERIFIER, grant_type: 'authorization_code' });
    expect(tokens.status).toBe(400);
    expect(tokens.body.error).toBe('invalid_grant');
    expect(tokens.body.access_token).toBeUndefined();
  });

  it('issues nothing for an Allow that carries no valid consent token', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.post('/iam/sign-in/email').send({ email, password }).expect(200);
    const { params } = await authorizationRequest();

    const forged = await browser
      .post('/authorize')
      .type('form')
      .send({ ...params, lt_mcp_consent: 'approve', lt_mcp_csrf: '9999999999.forged' });

    expect(forged.status).toBe(200);
    expect(forged.headers.location).toBeUndefined();
    expect(forged.text).toContain('lt_mcp_csrf');
  });
});
