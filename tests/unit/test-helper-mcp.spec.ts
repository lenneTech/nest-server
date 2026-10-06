import { describe, expect, it } from 'vitest';

import { TestHelper } from '../../src/test/test.helper';

/**
 * TestHelper.parseMcpMessage — reads the JSON-RPC message out of an MCP Streamable HTTP response.
 *
 * The transport answers a request as an SSE stream and a notification with an empty 202, and a
 * server may send notifications (progress, logging) before the response on the same stream. The
 * parser has to pick the response, not the first event, or a test asserts against a notification.
 */
describe('TestHelper.parseMcpMessage', () => {
  const sse = (...events: object[]) => ({
    headers: { 'content-type': 'text/event-stream' },
    text: events.map(event => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  });

  it('returns the JSON-RPC response from an SSE stream', () => {
    const message = TestHelper.parseMcpMessage(sse({ id: 2, jsonrpc: '2.0', result: { tools: [] } }));

    expect(message).toEqual({ id: 2, jsonrpc: '2.0', result: { tools: [] } });
  });

  it('skips notifications that precede the response on the same stream', () => {
    const message = TestHelper.parseMcpMessage(
      sse(
        { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
        { id: 3, jsonrpc: '2.0', result: { content: [] } },
      ),
    );

    expect(message?.id).toBe(3);
  });

  it('returns a JSON-RPC error as the message, so a test can assert it', () => {
    const message = TestHelper.parseMcpMessage(sse({ error: { code: -32601, message: 'Method not found' }, id: 4, jsonrpc: '2.0' }));

    expect(message?.error.code).toBe(-32601);
  });

  it('reads an SSE stream even without a content-type header', () => {
    const message = TestHelper.parseMcpMessage({ text: 'data: {"id":5,"jsonrpc":"2.0","result":{}}\n\n' });

    expect(message?.id).toBe(5);
  });

  it('parses a plain JSON body, e.g. the 404 for an unknown session', () => {
    const message = TestHelper.parseMcpMessage({
      headers: { 'content-type': 'application/json' },
      text: '{"error":"Unknown or expired MCP session"}',
    });

    expect(message).toEqual({ error: 'Unknown or expired MCP session' });
  });

  it('returns null for the empty body of a notification', () => {
    expect(TestHelper.parseMcpMessage({ headers: {}, text: '' })).toBeNull();
  });

  it('ignores data lines that are no JSON instead of throwing', () => {
    const message = TestHelper.parseMcpMessage({
      headers: { 'content-type': 'text/event-stream' },
      text: 'data: not-json\n\ndata: {"id":6,"jsonrpc":"2.0","result":{}}\n\n',
    });

    expect(message?.id).toBe(6);
  });
});
