/**
 * Coexistence with `@nestjs/mcp` (nestjs-ai plan §4): `CoreAiMcpOAuthService.createMcpTokenVerifier()` makes the
 * framework's MCP OAuth authorization server the identity provider of a project's own `McpModule` endpoint, and the
 * user of an accepted token reaches the tool's guards — and only that user.
 */
import { INestApplication, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { McpModule, McpRegistry, Tool } from '@nestjs/mcp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { BetterAuthRolesGuard } from '../../src/core/modules/better-auth/better-auth-roles.guard';
import { createMcpOAuthMemoryConnection } from '../helpers/mcp-oauth-memory-connection';

const SECRET = 'unit-mcp-verifier-oauth-secret-0123456789abcdef';
const RESOURCE = 'https://api.example.com/mcp';
const ADMIN = { id: 'user-admin', roles: ['admin'] };
const MEMBER = { id: 'user-member', roles: [] as string[] };

function configure(mcp: Record<string, unknown> = {}): void {
  ConfigService.setConfig(
    { ai: { mcp: { oauth: true, oauthSecret: SECRET, ...mcp } }, baseUrl: 'https://api.example.com', env: 'production' } as any,
    { reInit: true, warn: false },
  );
}

async function oauthService(): Promise<CoreAiMcpOAuthService> {
  const connection = createMcpOAuthMemoryConnection();
  for (const user of [ADMIN, MEMBER]) {
    await connection.db.collection('users').insertOne({ _id: user.id, roles: user.roles } as any);
  }
  return new CoreAiMcpOAuthService(connection as any);
}

@Injectable()
class ProjectMcpTools {
  @Tool({ inputSchema: z.looseObject({}), name: 'admin_report' })
  @Roles(RoleEnum.ADMIN)
  report() {
    return { content: [{ text: 'report', type: 'text' }] };
  }
}

describe('createMcpTokenVerifier()', () => {
  let app: INestApplication;

  beforeAll(async () => {
    configure();
    @Module({
      imports: [McpModule.forRoot({ name: 'project-mcp', version: '0.0.0' })],
      providers: [ProjectMcpTools, BetterAuthRolesGuard, { provide: APP_GUARD, useExisting: BetterAuthRolesGuard }],
    })
    class ProjectMcpModule {}
    const moduleRef = await Test.createTestingModule({ imports: [ProjectMcpModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => configure());

  function callTool(authInfo: unknown) {
    const entry = app.get(McpRegistry).tools.find((tool) => tool.name === 'admin_report');
    return entry.handler({}, {
      authInfo,
      era: 'modern',
      kind: 'tool',
      name: 'admin_report',
      reportProgress: async () => undefined,
      request: { headers: {} },
      server: {} as any,
      signal: new AbortController().signal,
      transport: 'http',
    } as any);
  }

  it('accepts a token of this server for the configured resource, and the guards decide on its user', async () => {
    const svc = await oauthService();
    const verifier = svc.createMcpTokenVerifier({ resource: RESOURCE });

    const admin = await verifier.verifyAccessToken(svc.signAccessToken(ADMIN.id, 'client-1', 3600, RESOURCE));
    expect(admin).toMatchObject({ clientId: 'client-1', resource: RESOURCE, scopes: [] });
    expect(typeof admin.expiresAt).toBe('number');
    await expect(callTool(admin)).resolves.toBeDefined();

    const member = await verifier.verifyAccessToken(svc.signAccessToken(MEMBER.id, 'client-1', 3600, RESOURCE));
    await expect(callTool(member)).rejects.toThrow(/LTNS_0101/);
  });

  it('refuses a forged, expired or unknown-user token with null', async () => {
    const svc = await oauthService();
    const verifier = svc.createMcpTokenVerifier({ resource: RESOURCE });
    const token = svc.signAccessToken(ADMIN.id, 'client-1', 3600, RESOURCE);
    await expect(verifier.verifyAccessToken(`${token}x`)).resolves.toBeNull();
    await expect(verifier.verifyAccessToken(svc.signAccessToken(ADMIN.id, 'client-1', -10, RESOURCE))).resolves.toBeNull();
    await expect(verifier.verifyAccessToken(svc.signAccessToken('nobody', 'client-1', 3600, RESOURCE))).resolves.toBeNull();
  });

  /**
   * @regression   12.10.0 — `ai.mcp.roles` is the account-level MCP rule on every way in (12.8.6). A project's own
   *   `@nestjs/mcp` endpoint authenticated through this verifier is one more way in, so a token of an account that may
   *   not use MCP is refused there too, on every request.
   * @seen-failing Drop the checkMcpAccess() call from createMcpTokenVerifier() in
   *   src/core/modules/ai/services/core-ai-mcp-oauth.service.ts — registered as mutation
   *   `mcp-token-verifier-skips-access-rule` in tests/regression-mutations.json.
   */
  it('applies ai.mcp.roles on every verification', async () => {
    configure({ roles: ['admin'] });
    const svc = await oauthService();
    const verifier = svc.createMcpTokenVerifier({ resource: RESOURCE });
    await expect(verifier.verifyAccessToken(svc.signAccessToken(MEMBER.id, 'client-1', 3600, RESOURCE))).resolves.toBeNull();
    await expect(verifier.verifyAccessToken(svc.signAccessToken(ADMIN.id, 'client-1', 3600, RESOURCE))).resolves.not.toBeNull();
  });

  it('cannot be created while ai.mcp.oauth is off, or without an absolute resource', async () => {
    const svc = await oauthService();
    expect(() => svc.createMcpTokenVerifier({ resource: 'mcp' })).toThrow(/absolute URL/);
    ConfigService.setConfig({ ai: { mcp: {} }, env: 'production' } as any, { reInit: true, warn: false });
    expect(() => svc.createMcpTokenVerifier({ resource: RESOURCE })).toThrow(/ai\.mcp\.oauth/);
  });
});
