import { describe, expect, it, vi } from 'vitest';

import { ResolvedAiConnection } from '../../src/core/modules/ai/interfaces/resolved-ai-connection.interface';
import { OpenAiCompatibleProvider } from '../../src/core/modules/ai/providers/openai-compatible.provider';

/**
 * `response_format: {type:'json_object'}` is attached from a CONNECTION flag
 * (`supportsJsonResponse`), but two things about a single call can make that flag
 * inapplicable: the call may target a DIFFERENT model than the one the probe ran
 * against, and its PROMPT may ask for prose. Both are narrowings; neither may ever
 * widen, because the flag is the only evidence the endpoint supports the parameter.
 */
describe('OpenAiCompatibleProvider — per-call JSON mode', () => {
  const conn = (overrides: Partial<ResolvedAiConnection> = {}): ResolvedAiConnection =>
    ({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test/v1',
      id: 'conn-1',
      model: 'm',
      ...overrides,
    }) as ResolvedAiConnection;

  const capture = (payload: unknown = { choices: [{ message: { content: 'hi' } }] }) => {
    const seen: any[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: any) => {
      seen.push({ body: JSON.parse(init.body), url });
      return { json: async () => payload, ok: true, status: 200 } as Response;
    }) as never);
    return { seen, spy };
  };

  it('attaches response_format by default when the connection supports it', async () => {
    const { seen, spy } = capture();
    try {
      await new OpenAiCompatibleProvider(conn({ supportsJsonResponse: true })).chat([], []);
      expect(seen[0].body.response_format).toEqual({ type: 'json_object' });
    } finally {
      spy.mockRestore();
    }
  });

  it('narrows JSON mode off for a single call', async () => {
    const { seen, spy } = capture();
    try {
      await new OpenAiCompatibleProvider(conn({ supportsJsonResponse: true })).chat([], [], {
        jsonResponse: false,
      });
      expect(seen[0].body.response_format).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('NEVER widens: the option cannot assert JSON mode the probe never measured', async () => {
    // The flag is measured per connection. An option that could switch it ON would
    // assert a capability nobody probed, and the endpoint answers that with a 4xx.
    const { seen, spy } = capture();
    try {
      await new OpenAiCompatibleProvider(conn({ supportsJsonResponse: false })).chat([], [], {
        jsonResponse: true,
      });
      expect(seen[0].body.response_format).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Per-request model override vs. per-CONNECTION capability probe.
 *
 * `chat()` accepts `options.model`, but `capabilities` is frozen in the constructor
 * from the CONNECTION's flags — which were probed against `connection.model`. The
 * two are independent, and applying the one to the other asserts something nobody
 * measured. These cases pin both halves: the override must reach the wire, and it
 * must not drag a foreign capability with it.
 */
describe('OpenAiCompatibleProvider.chat — per-request model', () => {
  const connection = {
    apiKey: 'test-key',
    baseUrl: 'https://llm.example.test/v1',
    id: 'conn-1',
    model: 'connection-model',
    providerType: 'openai-compatible',
    supportsJsonResponse: true,
    supportsNativeTools: true,
  } as unknown as ResolvedAiConnection;

  /** Capture the request body of the single completion call. */
  function stubFetch(): { body: () => any; spy: ReturnType<typeof vi.spyOn> } {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        })) as any,
    );
    return { body: () => JSON.parse((spy.mock.calls[0][1] as any).body), spy };
  }

  it('sends the per-request model instead of the connection model', async () => {
    const { body, spy } = stubFetch();
    try {
      await new OpenAiCompatibleProvider(connection).chat([{ content: 'hi', role: 'user' }], [], {
        model: 'per-usage-model',
      });
      // The last hop of the chain the wiring specs stop short of: registry ->
      // service options -> HTTP body. An upstream sync that drops the `??` here
      // would silently un-pin every per-usage model with every test still green.
      expect(body().model).toBe('per-usage-model');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the connection model when no override is given', async () => {
    const { body, spy } = stubFetch();
    try {
      await new OpenAiCompatibleProvider(connection).chat([{ content: 'hi', role: 'user' }], []);
      expect(body().model).toBe('connection-model');
    } finally {
      spy.mockRestore();
    }
  });

  it('does NOT apply the probed JSON capability to an overridden model', async () => {
    const { body, spy } = stubFetch();
    try {
      await new OpenAiCompatibleProvider(connection).chat([{ content: 'hi', role: 'user' }], [], {
        model: 'never-probed-model',
      });
      // `supportsJsonResponse` was probed against `connection-model`. Attaching
      // `response_format` for a different model asserts support that was never
      // measured; where it is missing the endpoint 4xxes and a caller that does not
      // retry transport errors degrades to nothing but a warn log.
      expect(body().response_format).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('still applies the probed JSON capability when the model matches', async () => {
    const { body, spy } = stubFetch();
    try {
      await new OpenAiCompatibleProvider(connection).chat([{ content: 'hi', role: 'user' }], [], {
        model: 'connection-model',
      });
      expect(body().response_format).toEqual({ type: 'json_object' });
    } finally {
      spy.mockRestore();
    }
  });
});
