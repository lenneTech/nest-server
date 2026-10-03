import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { CoreAiMcpController } from '../../src/core/modules/ai/core-ai-mcp.controller';
import { IAiTool } from '../../src/core/modules/ai/interfaces/ai-tool.interface';
import { CoreAiMcpService } from '../../src/core/modules/ai/services/core-ai-mcp.service';
import { AiToolRegistry, AiToolUser } from '../../src/core/modules/ai/tools/ai-tool.registry';

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    handleRequest = vi.fn(async () => undefined);
    sessionId = 'session-1';
  },
}));

/**
 * Unit Tests: an MCP session acts with the user's CURRENT rights, not those it was opened with.
 *
 * `createServer(user)` used to capture the user object once, at `initialize`, and every later
 * `tools/list` and `tools/call` of that session — which can stay open for hours — used that snapshot:
 * for the tool filter and as `serviceOptions.currentUser`. An administrator who lost the role kept the
 * admin-only tools and passed every CrudService check against the stale roles until the session ended,
 * although each request already re-resolved the user for the ownership check.
 *
 * The controller now refreshes the session's user on every request, and the server reads it per call.
 *
 * @regression   11.42.0 (found in review) — an MCP session kept the role snapshot from its first
 *   request for its whole life.
 * @seen-failing Stop refreshing `entry.user` in `handlePost()` in
 *   src/core/modules/ai/core-ai-mcp.controller.ts — registered as mutation `ai-mcp-session-user-stale`
 *   in tests/regression-mutations.json.
 */
describe('MCP sessions follow the current user', () => {
  const tool = (name: string, roles: string[], seen: AiToolUser[] = []): IAiTool =>
    ({
      description: name,
      execute: async (_args: unknown, context: { currentUser?: AiToolUser }) => {
        seen.push(context.currentUser as AiToolUser);
        return { ok: true };
      },
      name,
      parameters: { properties: {}, type: 'object' },
      roles,
    }) as unknown as IAiTool;

  it('createServer() reads the user per request through a getter', async () => {
    const seen: AiToolUser[] = [];
    const registry = new AiToolRegistry();
    registry.register(tool('admin_tool', [RoleEnum.ADMIN], seen));
    registry.register(tool('user_tool', [RoleEnum.S_USER], seen));
    const service = new CoreAiMcpService(registry);

    const holder: { user: AiToolUser } = { user: { id: 'u1', roles: [RoleEnum.ADMIN] } };
    const server = await service.createServer(() => holder.user);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['admin_tool', 'user_tool']);

    // The role is revoked while the session stays open.
    holder.user = { id: 'u1', roles: [] };

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['user_tool']);
    const refused = await client.callTool({ arguments: {}, name: 'admin_tool' });
    expect(refused.isError).toBe(true);
    await client.callTool({ arguments: {}, name: 'user_tool' });
    expect(seen.at(-1)?.roles).toEqual([]);

    await client.close();
  });

  it('createServer() still accepts a plain user object', async () => {
    const registry = new AiToolRegistry();
    registry.register(tool('user_tool', [RoleEnum.S_USER]));
    const server = await new CoreAiMcpService(registry).createServer({ id: 'u1', roles: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['user_tool']);
    await client.close();
  });

  it('the controller refreshes the session user on every request', async () => {
    let userRef: (() => AiToolUser) | undefined;
    const mcpService: any = {
      createServer: vi.fn(async (ref: () => AiToolUser) => {
        userRef = ref;
        return { connect: async () => undefined };
      }),
    };
    const controller = new CoreAiMcpController(mcpService, { loadUser: vi.fn(), verifyAccessToken: vi.fn() } as any);
    const res: any = { json: () => res, set: () => res, status: () => res };
    const request = (roles: string[], sessionId?: string): any => ({
      body: sessionId
        ? { id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} }
        : { id: 1, jsonrpc: '2.0', method: 'initialize', params: {} },
      get: () => 'api.example.com',
      headers: sessionId ? { 'mcp-session-id': sessionId } : {},
      protocol: 'https',
      user: { id: 'u1', roles },
    });

    await controller.handlePost(request([RoleEnum.ADMIN]), res);
    expect(typeof userRef).toBe('function');
    expect(userRef!().roles).toEqual([RoleEnum.ADMIN]);

    // A later request on the same session, after the role was revoked.
    await controller.handlePost(request([], 'session-1'), res);
    expect(userRef!().roles).toEqual([]);

    // GET (the SSE stream) carries the session too.
    await controller.handleGet(request(['auditor'], 'session-1'), res);
    expect(userRef!().roles).toEqual(['auditor']);

    controller.onModuleDestroy();
  });
});
