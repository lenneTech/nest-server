/**
 * `ai.mcp.stateless` — `/ai/mcp` without sessions.
 *
 * The session map is process memory, so the session mode needs sticky sessions behind a load
 * balancer; without them, every request that lands on another replica answers 404 and the client
 * reconnects in a loop. The stateless mode builds a server and transport per POST instead. The
 * cases pin the branch decisions that differ from the session mode: a session id a client still
 * sends is ignored instead of answered 404, GET and DELETE answer 405, and nothing of this applies
 * while the option is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAiMcpController } from '../../src/core/modules/ai/core-ai-mcp.controller';

function buildRequest(options: { body?: any; sessionId?: string } = {}): any {
  return {
    body: options.body ?? { id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} },
    get: () => 'api.example.com',
    headers: options.sessionId ? { 'mcp-session-id': options.sessionId } : {},
    protocol: 'https',
    user: { id: 'user-1' },
  };
}

function buildResponse() {
  const sent: { body?: any; headers: Record<string, string>; status?: number } = { headers: {} };
  const res: any = {
    json: (body: any) => {
      sent.body = body;
      return res;
    },
    on: vi.fn(),
    set: (name: string, value: string) => {
      sent.headers[name] = value;
      return res;
    },
    status: (code: number) => {
      sent.status = code;
      return res;
    },
  };
  return { res, sent };
}

function buildController() {
  const mcpService: any = {
    createServer: vi.fn(async () => {
      // Reaching this means the handler decided to BUILD a server rather than refuse the request.
      throw new Error('createServer reached');
    }),
  };
  const oauthService: any = { loadUser: vi.fn(), verifyAccessToken: vi.fn() };
  return { controller: new CoreAiMcpController(mcpService, oauthService), mcpService };
}

describe('CoreAiMcpController — ai.mcp.stateless', () => {
  let original: unknown;

  beforeEach(() => {
    original = ConfigService.get('ai.mcp');
  });

  afterEach(() => {
    ConfigService.setProperty('ai.mcp', original);
  });

  it('ignores a session id a client still sends instead of answering 404', async () => {
    // A client that held a session before the switch to stateless would otherwise be sent into a
    // reconnect that cannot help: there is no session its id could ever refer to.
    ConfigService.setProperty('ai.mcp', { stateless: true });
    const { controller, mcpService } = buildController();
    const { res, sent } = buildResponse();

    await expect(controller.handlePost(buildRequest({ sessionId: 'from-before' }), res)).rejects.toThrow(
      'createServer reached',
    );
    expect(sent.status).toBeUndefined();
    // Built for the request's user, not through a session getter.
    expect(mcpService.createServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }));
  });

  it('builds a per-request server for the user itself, not for a session that outlives it', async () => {
    // The session mode passes a getter (`() => entry.user`) that later requests refresh; a server that
    // lives for one request is bound to that request's user directly.
    ConfigService.setProperty('ai.mcp', { stateless: true });
    const { controller, mcpService } = buildController();
    const { res, sent } = buildResponse();

    await expect(controller.handlePost(buildRequest(), res)).rejects.toThrow('createServer reached');
    expect(sent.status).toBeUndefined();
    expect(typeof mcpService.createServer.mock.calls[0][0]).toBe('object');
  });

  it.each(['handleGet', 'handleDelete'] as const)('answers 405 with Allow: POST to %s', async (method) => {
    ConfigService.setProperty('ai.mcp', { stateless: true });
    const { controller } = buildController();
    const { res, sent } = buildResponse();

    await controller[method](buildRequest({ sessionId: 'any' }), res);

    expect(sent.status).toBe(405);
    expect(sent.headers.Allow).toBe('POST');
  });

  it('keeps the session mode while the option is off: an unknown session id answers 404', async () => {
    ConfigService.setProperty('ai.mcp', true);
    const { controller } = buildController();
    const { res, sent } = buildResponse();

    await controller.handlePost(buildRequest({ sessionId: 'from-before' }), res);

    expect(sent.status).toBe(404);
  });
});
