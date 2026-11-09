/**
 * `ai.mcp.roles` / `CoreAiMcpOAuthService.mayUseMcp()` — who may use MCP at all, on every way in.
 *
 * Until 12.8.6 the framework had no account-level MCP rule. A project that refused some accounts on the consent route
 * (`/authorize`) refused only a NEW OAuth grant: `/ai/mcp` accepts the user's own session token or JWT as bearer, which
 * never passes `/authorize`, and a grant issued earlier kept refreshing. The rule is now checked where every credential
 * arrives — each `/ai/mcp` request, the consent route, the code and the refresh exchange — and a misconfiguration fails
 * the boot instead of reading as "everyone may".
 */
import express from 'express';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAiMcpController } from '../../src/core/modules/ai/core-ai-mcp.controller';
import { mountAiMcpOAuth } from '../../src/core/modules/ai/helpers/ai-mcp-oauth.helper';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { createMcpOAuthMemoryConnection } from '../helpers/mcp-oauth-memory-connection';

const SECRET = 'unit-mcp-access-oauth-secret-0123456789abcdef';
const REDIRECT_URI = 'http://127.0.0.1:33418/callback';
const CODE_VERIFIER = 'mcp-access-code-verifier-0123456789abcdef0123456789';
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');
// Ids that are no ObjectId, so the in-memory `users` collection matches them as plain strings
const ADMIN = { email: 'admin@example.com', id: 'user-admin', name: 'Admin', roles: ['admin'] };
const MEMBER = { email: 'member@example.com', id: 'user-member', name: 'Member', roles: [] as string[] };

function configure(mcp: Record<string, unknown>): void {
  ConfigService.setConfig(
    {
      ai: { mcp: { oauth: true, oauthSecret: SECRET, ...mcp } },
      baseUrl: 'https://api.example.com',
      env: 'production',
    } as any,
    { reInit: true, warn: false },
  );
}

/** An OAuth service on an in-memory connection whose `users` collection holds ADMIN and MEMBER. */
async function oauthService() {
  const connection = createMcpOAuthMemoryConnection();
  for (const user of [ADMIN, MEMBER]) {
    await connection.db.collection('users').insertOne({ _id: user.id, roles: user.roles });
  }
  return { connection, svc: new CoreAiMcpOAuthService(connection as any) };
}

describe('ai.mcp.roles — resolution', () => {
  afterEach(() => configure({}));

  it('admits every signed-in user while unset, as before 12.8.6', async () => {
    configure({});
    const { svc } = await oauthService();

    expect(() => svc.onModuleInit()).not.toThrow();
    expect(await svc.checkMcpAccess(MEMBER)).toBe(true);
    expect(await svc.checkMcpAccess({ id: 'no-roles' })).toBe(true);
  });

  it('admits only holders of a listed role, as an array or a comma-separated string', async () => {
    const { svc } = await oauthService();
    for (const roles of [['admin', 'support'], ' admin , support ']) {
      configure({ roles });
      expect(() => svc.onModuleInit()).not.toThrow();
      expect(await svc.checkMcpAccess(ADMIN)).toBe(true);
      expect(await svc.checkMcpAccess({ id: 'u-support', roles: ['support'] })).toBe(true);
      expect(await svc.checkMcpAccess(MEMBER)).toBe(false);
      expect(await svc.checkMcpAccess({ id: 'u-other', roles: ['editor'] })).toBe(false);
    }
  });

  it('fails the boot on a value that names no role or a system role, and refuses at runtime', async () => {
    const { svc } = await oauthService();
    for (const roles of [[], '', ['admin', ''], 'admin,', [1], {}, 's_user', ['S_EVERYONE', 'admin']]) {
      configure({ roles });
      expect(() => svc.onModuleInit(), JSON.stringify(roles)).toThrow(/ai\.mcp\.roles/);
      // A subclass whose onModuleInit() skips the check still refuses — never "everyone may"
      expect(await svc.checkMcpAccess(ADMIN), JSON.stringify(roles)).toBe(false);
    }
  });

  it('refuses when an overridden mayUseMcp() throws or answers anything but true', async () => {
    configure({});
    const { connection } = await oauthService();
    class Throwing extends CoreAiMcpOAuthService {
      override async mayUseMcp(): Promise<boolean> {
        throw new Error('rule store unavailable');
      }
    }
    class Truthy extends CoreAiMcpOAuthService {
      override async mayUseMcp(): Promise<boolean> {
        return 'yes' as unknown as boolean;
      }
    }
    const throwing = new Throwing(connection as any);
    const logged = vi.spyOn((throwing as any).logger, 'error').mockImplementation(() => undefined);

    expect(await throwing.checkMcpAccess(ADMIN)).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('refusing'));
    expect(await new Truthy(connection as any).checkMcpAccess(ADMIN)).toBe(false);
    expect(await new CoreAiMcpOAuthService(connection as any).checkMcpAccess({ id: '' })).toBe(false);
  });
});

describe('/ai/mcp — checked on every request, whatever the credential', () => {
  beforeEach(() => configure({ roles: ['admin'] }));
  afterEach(() => configure({}));

  function buildResponse() {
    const sent: { body?: any; status?: number } = {};
    const res: any = {
      json: (body: any) => {
        sent.body = body;
        return res;
      },
      on: vi.fn(),
      set: () => res,
      status: (code: number) => {
        sent.status = code;
        return res;
      },
    };
    return { res, sent };
  }

  async function buildController() {
    const mcpService: any = {
      createServer: vi.fn(async () => {
        // Reaching this means the handler admitted the request
        throw new Error('createServer reached');
      }),
    };
    const { svc } = await oauthService();
    return { controller: new CoreAiMcpController(mcpService, svc), mcpService, svc };
  }

  const initialize = { id: 1, jsonrpc: '2.0', method: 'initialize', params: {} };
  const sessionRequest = (user: unknown, headers: Record<string, string> = {}): any => ({
    body: initialize,
    get: () => 'api.example.com',
    headers,
    protocol: 'https',
    user,
  });

  /**
   * @regression   12.8.5 — `/ai/mcp` had no account-level rule: a refusal on the consent route was bypassed with the
   *   user's own session token or JWT as bearer, which never passes `/authorize`.
   * @seen-failing Drop the checkMcpAccess() call from handlePost() in src/core/modules/ai/core-ai-mcp.controller.ts —
   *   registered as mutation `mcp-route-skips-access-check` in tests/regression-mutations.json.
   */
  it('refuses a session or JWT user without the role with 403, before any session handling', async () => {
    const { controller, mcpService } = await buildController();

    const post = buildResponse();
    await controller.handlePost(sessionRequest(MEMBER), post.res);
    expect(post.sent.status).toBe(403);
    expect(post.sent.body.error).toMatch(/may not use MCP/);

    // GET and DELETE are checked before their session lookup too: a stale id answers 403, not 404
    for (const method of ['handleGet', 'handleDelete'] as const) {
      const other = buildResponse();
      await controller[method](sessionRequest(MEMBER, { 'mcp-session-id': 'session-of-before' }), other.res);
      expect(other.sent.status, method).toBe(403);
    }
    expect(mcpService.createServer).not.toHaveBeenCalled();
  });

  /**
   * @regression   12.8.6 (found in review) — the rule must hold on every request, not only on the `initialize` that
   *   opens a session: a check placed where a session is created let a user whose role was withdrawn keep calling tools
   *   on the session opened before, and let every refused user through in stateless mode.
   * @seen-failing Check access in handlePost() only for an `initialize` (src/core/modules/ai/core-ai-mcp.controller.ts)
   *   — registered as mutation `mcp-access-checked-at-initialize-only` in tests/regression-mutations.json.
   */
  it('ends an open session with the first request after the right was withdrawn', async () => {
    const { controller } = await buildController();
    const openSession = (owner: typeof ADMIN | typeof MEMBER, id: string) => {
      const transport = { handleRequest: vi.fn(async () => undefined), sessionId: id };
      // Opened while the owner still held the role
      (controller as any).transports.set(id, {
        lastUsed: Date.now(),
        ownerId: owner.id,
        transport,
        user: { ...owner, roles: ['admin'] },
      });
      return transport;
    };
    const toolsCall = (user: unknown, sessionId: string): any => ({
      body: { id: 2, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'any_tool' } },
      get: () => 'api.example.com',
      headers: { 'mcp-session-id': sessionId },
      protocol: 'https',
      user,
    });

    // The member's role is gone now: the next request on the open session is refused, and nothing reaches it
    const memberSession = openSession(MEMBER, 'open-member');
    const refused = buildResponse();
    await controller.handlePost(toolsCall(MEMBER, 'open-member'), refused.res);
    expect(refused.sent.status).toBe(403);
    expect(memberSession.handleRequest).not.toHaveBeenCalled();

    // The fixture does reach an open session: an admin's request on theirs is served
    const adminSession = openSession(ADMIN, 'open-admin');
    await controller.handlePost(toolsCall(ADMIN, 'open-admin'), buildResponse().res);
    expect(adminSession.handleRequest).toHaveBeenCalledTimes(1);

    await controller.onModuleDestroy();
  });

  it('applies the rule in stateless mode, where no session exists', async () => {
    configure({ roles: ['admin'], stateless: true });
    const { controller, mcpService } = await buildController();
    const toolsList = (user: unknown): any => ({
      body: { id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} },
      get: () => 'api.example.com',
      headers: {},
      protocol: 'https',
      user,
    });

    const refused = buildResponse();
    await controller.handlePost(toolsList(MEMBER), refused.res);
    expect(refused.sent.status).toBe(403);
    expect(mcpService.createServer).not.toHaveBeenCalled();

    await expect(controller.handlePost(toolsList(ADMIN), buildResponse().res)).rejects.toThrow(
      'createServer reached',
    );
  });

  it('admits a session user holding the role', async () => {
    const { controller } = await buildController();
    const { res } = buildResponse();

    await expect(controller.handlePost(sessionRequest(ADMIN), res)).rejects.toThrow('createServer reached');
  });

  it('applies the same rule to an MCP OAuth access token, with the roles loadUser() reads', async () => {
    const { controller, svc } = await buildController();
    const bearer = (userId: string): any => ({
      body: initialize,
      get: () => 'api.example.com',
      headers: { authorization: `Bearer ${svc.signAccessToken(userId, 'client-1', 3600)}` },
      protocol: 'https',
    });

    const refused = buildResponse();
    await controller.handlePost(bearer(MEMBER.id), refused.res);
    expect(refused.sent.status).toBe(403);

    await expect(controller.handlePost(bearer(ADMIN.id), buildResponse().res)).rejects.toThrow(
      'createServer reached',
    );
  });

  it('changes nothing while ai.mcp.roles is unset', async () => {
    configure({});
    const { controller } = await buildController();

    await expect(controller.handlePost(sessionRequest(MEMBER), buildResponse().res)).rejects.toThrow(
      'createServer reached',
    );
  });
});

describe('consent route and token endpoint', () => {
  afterEach(() => configure({}));

  async function mountOAuth(user?: unknown) {
    const { connection, svc } = await oauthService();
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
    const clientId: string = registered.body.client_id;
    const authorize = () =>
      request(server).get('/authorize').query({
        client_id: clientId,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        state: 'state-1',
      });
    const token = (body: Record<string, string>) =>
      request(server)
        .post('/token')
        .type('form')
        .send({ client_id: clientId, ...body });
    return { authorize, clientId, connection, svc, token };
  }

  /**
   * @regression   12.8.5 — the consent route had no account-level rule of its own; a project had to override
   *   authorizeConsent() and still left `/ai/mcp` open (see the controller cases above).
   * @seen-failing Skip the checkMcpAccess() refusal in authorizeConsent() in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation
   *   `mcp-consent-ignores-access` in tests/regression-mutations.json.
   */
  it('answers a signed-in user without the role with the refusal notice instead of the form', async () => {
    configure({ roles: ['admin'] });
    const { authorize } = await mountOAuth(MEMBER);

    const german = await authorize().set('accept-language', 'de-DE');
    expect(german.status).toBe(403);
    expect(german.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(german.text).toContain('<h1>Kein Zugriff über MCP</h1>');
    expect(german.text).toContain('Angemeldet als <strong>member@example.com</strong>');
    expect(german.text).not.toContain('<form');
    expect(german.text).not.toContain('lt_mcp_csrf');

    const english = await authorize().set('accept-language', 'en');
    expect(english.status).toBe(403);
    expect(english.text).toContain('<h1>No MCP access</h1>');
  });

  it('shows the consent form to a holder of the role, and to everyone while unset', async () => {
    configure({ roles: ['admin'] });
    expect((await (await mountOAuth(ADMIN)).authorize()).text).toContain('lt-mcp-allow');

    configure({});
    expect((await (await mountOAuth(MEMBER)).authorize()).text).toContain('lt-mcp-allow');
  });

  it('refuses to exchange an authorization code of a user who may not use MCP', async () => {
    configure({ roles: ['admin'] });
    const { clientId, svc, token } = await mountOAuth();
    const codeFor = async (userId: string) => {
      const code = `code-${userId}`;
      await svc.saveAuthorizationCode(code, { clientId, codeChallenge: CODE_CHALLENGE, userId });
      return code;
    };

    const refused = await token({
      code: await codeFor(MEMBER.id),
      code_verifier: CODE_VERIFIER,
      grant_type: 'authorization_code',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_grant');

    const admitted = await token({
      code: await codeFor(ADMIN.id),
      code_verifier: CODE_VERIFIER,
      grant_type: 'authorization_code',
    });
    expect(admitted.status).toBe(200);
    expect(admitted.body.access_token).toBeTruthy();
  });

  /**
   * @regression   12.8.5 — a grant issued before the right was withdrawn kept refreshing for good.
   * @seen-failing Skip the grantMayUseMcp() refusal in exchangeRefreshToken in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation
   *   `mcp-refresh-ignores-access` in tests/regression-mutations.json.
   */
  it('refuses to refresh a grant of a user who may no longer use MCP, and leaves no token behind', async () => {
    configure({});
    const { clientId, connection, svc, token } = await mountOAuth();
    const issued = await svc.issueRefreshToken(MEMBER.id, clientId);

    // The right is withdrawn after the grant was issued
    configure({ roles: ['admin'] });
    const refused = await token({ grant_type: 'refresh_token', refresh_token: issued });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_grant');
    const left = (connection.db.collection('aiMcpOAuthRefreshTokens') as any).docs.filter(
      (doc: any) => doc.userId === MEMBER.id,
    );
    expect(left).toEqual([]);

    const adminGrant = await svc.issueRefreshToken(ADMIN.id, clientId);
    const admitted = await token({ grant_type: 'refresh_token', refresh_token: adminGrant });
    expect(admitted.status).toBe(200);
  });
});
