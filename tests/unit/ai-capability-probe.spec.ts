import { describe, expect, it, vi } from 'vitest';

import { ResolvedAiConnection } from '../../src/core/modules/ai/interfaces/resolved-ai-connection.interface';
import { OpenAiCompatibleProvider } from '../../src/core/modules/ai/providers/openai-compatible.provider';

/**
 * Capability auto-detection.
 *
 * `detectCapabilities()` decides ONCE whether a connection may use native function
 * calling; the result is persisted and — per its own contract — never re-probed. A
 * false negative therefore degrades the assistant permanently to emulated tool
 * calling — a fallback the module is built to survive, not one to be forced into.
 *
 * The trap this spec pins down: the probe used a token budget so small that a
 * reasoning-style model spends it before it ever emits `tool_calls`. The endpoint
 * answers `200` with `finish_reason: 'length'` and no tool call, and the probe reads
 * that as "native tools unsupported".
 *
 * Measured against an OpenAI-compatible hosting endpoint on 2026-07-25 with the
 * probe's `tool_choice: 'required'` + trivial `ping` tool, varying only
 * `max_tokens`:
 *
 * | model                      | 8   | 64  | 256 |
 * |----------------------------|-----|-----|-----|
 * | Ministral-3-14B-Instruct   | ✅  | ✅  | ✅  |
 * | Mistral-Medium-3.5-128B    | ✅  | ✅  | ✅  |
 * | gpt-oss-120b               | ❌  | ✅  | ✅  |
 * | Qwen3.5-122B-A10B-FP8      | ❌  | ✅  | ✅  |
 * | Qwen3.6-35B-A3B-FP8        | ❌  | ❌  | ✅  |
 *
 * Hence the probe must (a) ask for a budget that survives a thinking phase and
 * (b) not read the FIRST truncated response as a negative result.
 *
 * It must still end with a definite boolean, though: an undetected flag is not
 * persisted, and the orchestrator re-detects whenever one is missing — so an
 * endpoint that always truncates would otherwise trigger an extra upstream
 * completion before every user prompt, ahead of the rate limiter and outside
 * budget accounting. Hence: retry once with a bigger budget, then decide.
 */
describe('OpenAiCompatibleProvider.detectCapabilities', () => {
  const connection = (overrides: Partial<ResolvedAiConnection> = {}): ResolvedAiConnection =>
    ({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.test/v1',
      id: 'conn-1',
      model: 'reasoning-model',
      ...overrides,
    }) as ResolvedAiConnection;

  /** Stub `fetch`, recording every request body the provider sends. */
  const stubFetch = (respond: (body: any) => { body: unknown; status?: number }) => {
    const seen: any[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      const { body: payload, status = 200 } = respond(body);
      return {
        json: async () => payload,
        ok: status >= 200 && status < 300,
        status,
      } as Response;
    }) as never);
    return { seen, spy };
  };

  const toolCallOk = {
    choices: [
      { finish_reason: 'tool_calls', message: { tool_calls: [{ function: { arguments: '{}', name: 'ping' } }] } },
    ],
  };
  const truncated = { choices: [{ finish_reason: 'length', message: { content: '' } }] };
  const jsonOk = { choices: [{ message: { content: '{"ok":true}' } }] };

  it('probes with a budget at least as large as the measured requirement, forcing a tool call', async () => {
    // 256 is not a round number picked for comfort — the table above measures
    // Qwen3.6-35B-A3B failing at 64 and passing at 256. Pin the documented value,
    // and pin `tool_choice: 'required'`: without it a model may answer in prose and
    // produce exactly the false negative this probe exists to avoid.
    const { seen, spy } = stubFetch((body) => ({ body: body.tools ? toolCallOk : jsonOk }));

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      const toolProbe = seen.find((b) => b.tools);
      expect(toolProbe?.max_tokens).toBeGreaterThanOrEqual(256);
      expect(toolProbe?.tool_choice).toBe('required');
      expect(toolProbe?.tools?.[0]?.function?.name).toBe('ping');
      expect(result.nativeTools).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('retries a truncated probe once with a larger budget instead of recording a false negative', async () => {
    // A reasoning model spends the budget thinking before it emits `tool_calls`.
    // `finish_reason: 'length'` means "budget exhausted", not "feature unsupported".
    const { seen, spy } = stubFetch((body) => {
      if (!body.tools) {
        return { body: jsonOk };
      }
      return { body: body.max_tokens > 256 ? toolCallOk : truncated };
    });

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      const toolProbes = seen.filter((b) => b.tools);
      expect(toolProbes).toHaveLength(2);
      expect(toolProbes[1].max_tokens).toBeGreaterThan(toolProbes[0].max_tokens);
      expect(result.nativeTools).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('bounds the retry: a second truncation resolves to false rather than staying undetected', async () => {
    // An undetected flag is never persisted, and the orchestrator re-detects on
    // every prompt while one is missing — so "leave it undefined" would mean one
    // extra upstream completion per user prompt, forever, ahead of the rate limiter.
    // Two attempts, then a definite answer.
    const { seen, spy } = stubFetch((body) => ({ body: body.tools ? truncated : jsonOk }));

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      expect(seen.filter((b) => b.tools)).toHaveLength(2);
      expect(result.nativeTools).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not waste a retry when the endpoint answers fully but ignores the tools', async () => {
    // A backend that silently drops `tools` finishes normally with plain content —
    // that IS a real negative, and a bigger budget cannot change it.
    const { seen, spy } = stubFetch((body) => ({
      body: body.tools
        ? { choices: [{ finish_reason: 'stop', message: { content: 'I cannot call tools.' } }] }
        : jsonOk,
    }));

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      expect(seen.filter((b) => b.tools)).toHaveLength(1);
      expect(result.nativeTools).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports "no native tools" when the endpoint rejects a tools request outright, without retrying', async () => {
    const { seen, spy } = stubFetch((body) =>
      body.tools ? { body: { error: 'tools unsupported' }, status: 400 } : { body: jsonOk },
    );

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      expect(seen.filter((b) => b.tools)).toHaveLength(1);
      expect(result.nativeTools).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts structured JSON only when the content actually parses', async () => {
    const { seen, spy } = stubFetch((body) => ({ body: body.tools ? toolCallOk : jsonOk }));

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      const jsonProbe = seen.find((b) => b.response_format);
      expect(jsonProbe?.response_format).toEqual({ type: 'json_object' });
      // Same budget as the tool probe — a reasoning model needs room to get past
      // its thinking phase before it emits anything parseable.
      expect(jsonProbe?.max_tokens).toBeGreaterThanOrEqual(256);
      expect(result.jsonResponse).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects structured JSON when the endpoint answers 200 but ignores response_format', async () => {
    // The failure this guards: a backend that does not implement `response_format`
    // silently drops the unknown field and answers in prose. Trusting the status
    // code alone persists `supportsJsonResponse: true` permanently, after which
    // every `chat()` call ships a parameter the endpoint disregards.
    const { spy } = stubFetch((body) => ({
      body: body.tools ? toolCallOk : { choices: [{ message: { content: 'Sure! Here you go: ok = true' } }] },
    }));

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      expect(result.jsonResponse).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects structured JSON when the endpoint rejects response_format outright', async () => {
    const { spy } = stubFetch((body) =>
      body.tools ? { body: toolCallOk } : { body: { error: 'response_format unsupported' }, status: 400 },
    );

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      expect(result.jsonResponse).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('retries a truncated JSON probe once with a larger budget', async () => {
    // The tool probe grew a retry ladder for exactly this reason; the JSON probe was
    // left with the FIRST budget only, and its own docblock's promise ("a reasoning
    // model needs room to get past its thinking phase") therefore held for one probe
    // and not the other. Measured against an
    // OpenAI-compatible hosting endpoint on 2026-09-03:
    // `Mistral-Medium-3.5-128B` answers `{"ok":true}` — but spends 820 completion
    // tokens getting there, so at 256 it returns `finish_reason: 'length'` with empty
    // content. That is how six correctly configured connections came to log
    // `supportsJsonResponse declared true but the endpoint reports false` on every
    // boot: a false negative from the probe, not drift at the endpoint.
    const { seen, spy } = stubFetch((body) => {
      if (body.tools) {
        return { body: toolCallOk };
      }
      return { body: body.max_tokens > 256 ? jsonOk : truncated };
    });

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      const jsonProbes = seen.filter((b) => b.response_format);
      expect(jsonProbes).toHaveLength(2);
      // Pin the VALUE, not just the direction: the docblock's measurement says
      // Mistral-Medium-3.5 spends 878 completion tokens on `{"ok":true}`, so a budget
      // lowered to e.g. 300 would keep this suite green and silently restore the false
      // negative. The first budget (256) is pinned the same way by the tool-probe test.
      expect(jsonProbes[1].max_tokens).toBeGreaterThanOrEqual(1024);
      expect(result.jsonResponse).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('bounds the JSON retry: a second truncation resolves to false', async () => {
    const { seen, spy } = stubFetch((body) => ({ body: body.tools ? toolCallOk : truncated }));

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      expect(seen.filter((b) => b.response_format)).toHaveLength(2);
      expect(result.jsonResponse).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not waste a JSON retry when the endpoint answered fully in prose', async () => {
    // A complete answer that simply is not JSON is a REAL negative — the endpoint
    // ignored `response_format`, and a bigger budget cannot change that.
    const { seen, spy } = stubFetch((body) => ({
      body: body.tools ? toolCallOk : { choices: [{ finish_reason: 'stop', message: { content: 'Sure! ok = true' } }] },
    }));

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      expect(seen.filter((b) => b.response_format)).toHaveLength(1);
      expect(result.jsonResponse).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not retry when the endpoint returned EMPTY content but finished normally', async () => {
    // The guard the retry ladder rests on. Without the `finish_reason` check this
    // case is indistinguishable from a truncation and would burn a second probe on
    // an endpoint that has already given its answer. Verified to mutate green
    // before this test existed.
    const { seen, spy } = stubFetch((body) => ({
      body: body.tools ? toolCallOk : { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
    }));

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      expect(seen.filter((b) => b.response_format)).toHaveLength(1);
      expect(result.jsonResponse).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('retries a PARTIAL truncated body, not just an empty one', async () => {
    // Truncation arrives in two shapes: a reasoning model buffers behind its thinking
    // phase and returns empty content, one that streams directly returns a partial
    // body. Both are `finish_reason: 'length'`. Classifying the partial one as
    // "non-JSON content" reaches the same false negative through the other door.
    const partial = { choices: [{ finish_reason: 'length', message: { content: '{"ok":tr' } }] };
    const { seen, spy } = stubFetch((body) => {
      if (body.tools) {
        return { body: toolCallOk };
      }
      return { body: body.max_tokens > 256 ? jsonOk : partial };
    });

    try {
      const result = await new OpenAiCompatibleProvider(connection()).detectCapabilities();
      expect(seen.filter((b) => b.response_format)).toHaveLength(2);
      expect(result.jsonResponse).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves an explicitly configured capability untouched (never probed)', async () => {
    const { seen, spy } = stubFetch(() => ({ body: { choices: [{ message: { content: '{}' } }] } }));

    try {
      const result = await new OpenAiCompatibleProvider(
        connection({ supportsJsonResponse: true, supportsNativeTools: false }),
      ).detectCapabilities();
      expect(result).toEqual({});
      expect(seen).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
