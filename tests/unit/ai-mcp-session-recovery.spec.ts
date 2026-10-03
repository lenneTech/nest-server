/**
 * What does `/ai/mcp` answer a client whose session this process no longer knows?
 *
 * The transport map is process memory, so every restart — every deploy — invalidates every
 * session id clients still hold. Which status that produces decides whether they recover on
 * their own: a client reacts to **404** by sending a fresh `initialize` (the spec requires it to),
 * and to a 400 not at all.
 *
 * This controller used to fall through to building a new transport for an unknown id, which looked
 * like a silent recovery and was not one: after a restart the client's next request is a
 * `tools/call`, never an `initialize`, so the fresh transport's own `validateSession()` answered
 * `400 Bad Request: Server not initialized`. The same dead session, one layer down. Found in a
 * consumer project running an older copy of this controller, where it meant every connected Claude
 * session died on every deploy until somebody reconnected by hand.
 *
 * The cases below pin the branch ORDER as much as the statuses: with a shared Redis registry, a
 * session that lives on another replica of the same user must keep answering 409 with that
 * replica's name. A 404 placed ahead of that check would turn a routable session back into a
 * misleading "unknown session".
 */
import { describe, expect, it, vi } from 'vitest';

import { CoreAiMcpController } from '../../src/core/modules/ai/core-ai-mcp.controller';

/** A request as the handler reads it: `req.user` is what `resolveUser()` finds first. */
function buildRequest(options: { body?: any; sessionId?: string; userId?: string }): any {
  return {
    body: options.body ?? { id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} },
    get: () => 'api.example.com',
    headers: options.sessionId ? { 'mcp-session-id': options.sessionId } : {},
    protocol: 'https',
    user: { id: options.userId ?? 'user-1' },
  };
}

/** Captures what the handler answered, so a case can assert on status AND body. */
function buildResponse() {
  const sent: { body?: any; status?: number } = {};
  const res: any = {
    json: (body: any) => {
      sent.body = body;
      return res;
    },
    set: () => res,
    status: (code: number) => {
      sent.status = code;
      return res;
    },
  };
  return { res, sent };
}

function buildController(options: { redis?: any } = {}): CoreAiMcpController {
  const mcpService: any = {
    createServer: vi.fn(async () => {
      // Reaching this means the handler decided to BUILD a session rather than refuse one. Throwing
      // is how a case proves it got that far without needing a real MCP server.
      throw new Error('createServer reached');
    }),
  };
  const oauthService: any = { loadUser: vi.fn(), verifyAccessToken: vi.fn() };
  return new CoreAiMcpController(mcpService, oauthService, options.redis);
}

describe('CoreAiMcpController — session recovery after a restart', () => {
  /**
   * @regression   11.41.6 — a POST carrying an unknown session id fell through to building a
   *   fresh transport, whose own `validateSession()` then answered `400 Server not initialized`
   *   for the `tools/call` a restarted client sends. A 400 is a status no MCP client recovers
   *   from, so every connected client stayed dead after every deploy.
   * @seen-failing Registered as `ai-mcp-unknown-session-not-404` in
   *   tests/regression-mutations.json — disabling the 404 guard turns this red.
   */
  it('answers 404 for a session id no replica knows, so the client re-initializes itself', async () => {
    const controller = buildController();
    const { res, sent } = buildResponse();

    await controller.handlePost(buildRequest({ sessionId: 'id-from-before-the-deploy' }), res);

    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ error: 'Unknown or expired MCP session' });
  });

  it('does not refuse an initialize that still carries a stale id, so no client can loop', async () => {
    // A client that keeps sending the old id would otherwise bounce between 404 and initialize. No
    // SDK client does this — it skips `initialize` once its transport has an id — but refusing the
    // combination outright would make a hand-written client unrecoverable.
    const controller = buildController();
    const { res, sent } = buildResponse();
    const request = buildRequest({
      body: { id: 1, jsonrpc: '2.0', method: 'initialize', params: {} },
      sessionId: 'id-from-before-the-deploy',
    });

    // It got as far as building a session instead of answering — that is what the stub proves.
    await expect(controller.handlePost(request, res)).rejects.toThrow('createServer reached');
    expect(sent.status).toBeUndefined();
  });

  /**
   * @regression   Guards the ORDER of the two checks: the unknown-session 404 sits BEHIND the
   *   shared-registry lookup. Ahead of it, a session that merely lives on another replica would
   *   read as "unknown", so the client would discard a session that is alive and routable and the
   *   operator would lose the only hint that sticky sessions are missing.
   * @seen-failing Registered as `ai-mcp-foreign-replica-404-instead-of-409` in
   *   tests/regression-mutations.json — making the registry lookup miss turns this red.
   */
  it('keeps the 409 for a session that lives on another replica of the same user', async () => {
    // The branch order is load-bearing: a 404 ahead of the registry lookup would turn a session
    // that is merely on the wrong replica into "unknown", and the client would throw away a session
    // that is alive and routable.
    const controller = buildController({
      redis: {
        enabled: true,
        getClient: () => ({
          get: async () => JSON.stringify({ instanceId: 'other-host:4242', userId: 'user-1' }),
        }),
        key: (...parts: string[]) => parts.join(':'),
      },
    });
    const { res, sent } = buildResponse();

    await controller.handlePost(buildRequest({ sessionId: 'held-elsewhere', userId: 'user-1' }), res);

    expect(sent.status).toBe(409);
    expect(sent.body.error).toContain('other-host:4242');
  });

  it('answers 404, not 409, when the other replica holds it for a DIFFERENT user', async () => {
    // Telling a caller which replica holds somebody else's session would confirm the id exists and
    // name an internal host. The registry lookup returns undefined for a foreign owner, so this
    // falls through to the same 404 an unknown id gets.
    const controller = buildController({
      redis: {
        enabled: true,
        getClient: () => ({
          get: async () => JSON.stringify({ instanceId: 'other-host:4242', userId: 'somebody-else' }),
        }),
        key: (...parts: string[]) => parts.join(':'),
      },
    });
    const { res, sent } = buildResponse();

    await controller.handlePost(buildRequest({ sessionId: 'held-elsewhere', userId: 'user-1' }), res);

    expect(sent.status).toBe(404);
  });
});
