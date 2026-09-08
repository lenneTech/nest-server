import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ResolvedAiConnection } from '../../src/core/modules/ai/interfaces/resolved-ai-connection.interface';
import { OpenAiCompatibleProvider } from '../../src/core/modules/ai/providers/openai-compatible.provider';

/**
 * Unit Tests: a reasoning model that spends the WHOLE output budget on thinking.
 *
 * THE DEFECT
 * ----------
 * The endpoint answers `200` with `finish_reason: 'length'`, an EMPTY
 * `choices[0].message.content` and `reasoning_tokens == completion_tokens` — the
 * thinking phase consumed the budget before the first character of the answer.
 * `chat()` handed that on as an empty string, indistinguishable from "the model had
 * nothing to say", and `LlmResponse` carried no `finishReason`, so no caller could
 * tell the two apart either. Every consumer with a modest `maxTokens` therefore got
 * nothing, silently, for as long as the connection pointed at such a model.
 *
 * Found in a consumer project where FIVE call sites broke at once (budgets of 256,
 * 300, 500, 900 and 900) — four of them degrade to a null-fallback and reported
 * nothing at all; only the fifth surfaced an error, which is what got it noticed.
 *
 * THE MEASUREMENT
 * ---------------
 * Against an OpenAI-compatible hosting endpoint on 2026-09-07, a German prose task
 * with `max_tokens: 900`, `temperature: 0.7`:
 *
 * | model                    | default            | `reasoning_effort: 'none'` |
 * |--------------------------|--------------------|----------------------------|
 * | Mistral-Medium-3.5-128B  | empty, 900/900     | 348 chars, 0.8 s           |
 * | Qwen3.6-35B-A3B-FP8      | empty, 900/900     | 399 chars, 0.8 s           |
 * | gpt-oss-120b             | 537 chars          | HTTP 400                   |
 * | Ministral-3-14B-Instruct | 1213 chars         | 901 chars                  |
 *
 * Two things follow, and both are load-bearing for the shape of the fix:
 *
 * - Raising the budget is NOT the fix. Mistral-Medium-3.5 spends whatever it is
 *   given: 900 → 900, 1500 → 1500, 2048 → 2048, 4096 → 4096 reasoning tokens,
 *   always with empty content. Only turning the thinking phase off returns an
 *   answer — and it is 7x faster while doing it.
 * - `reasoning_effort` can NOT be sent pre-emptively: gpt-oss-120b rejects it with
 *   `400`, and it is a model that works fine without it. So the retry fires only on
 *   the measured failure shape, and a 4xx on the retry falls back to the original
 *   response rather than turning a poor answer into a transport error.
 *
 * This mirrors the truncation retry the capability probes already carry — same
 * cause, same remedy, on the path that serves real completions.
 */
describe('OpenAiCompatibleProvider.chat — reasoning-starved completion', () => {
  const connection = {
    apiKey: 'test-key',
    baseUrl: 'https://llm.example.test/v1',
    id: 'conn-1',
    model: 'reasoning-model',
    providerType: 'openai-compatible',
  } as unknown as ResolvedAiConnection;

  /** The measured failure shape: budget fully spent on thinking, no answer. */
  const starved = {
    choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'thinking…' } }],
    usage: { completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 900 }, prompt_tokens: 300 },
  };
  const answered = {
    choices: [{ finish_reason: 'stop', message: { content: 'A perfectly ordinary paragraph.' } }],
    usage: { completion_tokens: 67, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens: 300 },
  };

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
        text: async () => JSON.stringify(payload),
      } as Response;
    }) as never);
    return { seen, spy };
  };

  const chat = () =>
    new OpenAiCompatibleProvider(connection).chat([{ content: 'hi', role: 'user' }], [], { maxTokens: 900 });

  /**
   * @regression   11.41.0 — `chat()` returned the empty completion as-is. A model
   *   whose thinking phase ate the whole budget produced `text: ''` with no way for
   *   the caller to know why, so every consumer with a modest `maxTokens` silently
   *   received nothing.
   * @seen-failing Return `false` from `isReasoningStarved()` in
   *   src/core/modules/ai/providers/openai-compatible.provider.ts — registered as
   *   mutation `ai-reasoning-starved-no-retry` in tests/regression-mutations.json.
   */
  it('retries once WITHOUT the thinking phase when the budget was spent before any answer', async () => {
    const { seen, spy } = stubFetch((body) => ({ body: body.reasoning_effort ? answered : starved }));
    try {
      const result = await chat();
      expect(seen).toHaveLength(2);
      expect(seen[0].reasoning_effort).toBeUndefined();
      expect(seen[1].reasoning_effort).toBe('none');
      expect(result.text).toBe('A perfectly ordinary paragraph.');
    } finally {
      spy.mockRestore();
    }
  });

  it('repeats the original request verbatim apart from the thinking switch', async () => {
    // The retry exists to remove ONE variable. Changing the budget, the model or
    // the messages alongside it would make the second answer incomparable to the
    // first and could silently alter what the caller asked for.
    const { seen, spy } = stubFetch((body) => ({ body: body.reasoning_effort ? answered : starved }));
    try {
      await chat();
      const { reasoning_effort, ...retried } = seen[1];
      expect(retried).toEqual(seen[0]);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * @regression   11.41.0 — a backend that rejects `reasoning_effort` must not have
   *   its 400 escape as the result of the ORIGINAL request. gpt-oss-120b answers
   *   400 to the parameter while working fine without it, so letting the retry's
   *   error propagate would replace a poor answer with a misleading transport
   *   failure and discard the usage the caller already paid for.
   * @seen-failing Return `false` from `isReasoningStarved()` in
   *   src/core/modules/ai/providers/openai-compatible.provider.ts — registered as
   *   mutation `ai-reasoning-starved-no-retry` in tests/regression-mutations.json.
   */
  it('keeps the original response when the endpoint rejects the thinking switch', async () => {
    const { seen, spy } = stubFetch((body) => (body.reasoning_effort ? { body: {}, status: 400 } : { body: starved }));
    try {
      const result = await chat();
      expect(seen).toHaveLength(2);
      expect(result.text).toBe('');
      expect(result.finishReason).toBe('length');
      expect(result.usage?.reasoningTokens).toBe(900);
    } finally {
      spy.mockRestore();
    }
  });

  it('retries at most once — a second starved answer is the final one', async () => {
    const { seen, spy } = stubFetch(() => ({ body: starved }));
    try {
      const result = await chat();
      expect(seen).toHaveLength(2);
      expect(result.text).toBe('');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not retry a normal answer', async () => {
    const { seen, spy } = stubFetch(() => ({ body: answered }));
    try {
      const result = await chat();
      expect(seen).toHaveLength(1);
      expect(result.text).toBe('A perfectly ordinary paragraph.');
      expect(result.finishReason).toBe('stop');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not retry a truncated answer that HAS content', async () => {
    // A partial answer is a budget problem, not a thinking problem. Retrying would
    // discard text the caller can still use, and `finishReason` now tells them it
    // was cut short.
    const partial = {
      choices: [{ finish_reason: 'length', message: { content: 'A sentence that began' } }],
      usage: { completion_tokens: 900, prompt_tokens: 300 },
    };
    const { seen, spy } = stubFetch(() => ({ body: partial }));
    try {
      const result = await chat();
      expect(seen).toHaveLength(1);
      expect(result.text).toBe('A sentence that began');
      expect(result.finishReason).toBe('length');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not retry an empty answer that finished normally', async () => {
    // `finish_reason: 'stop'` with empty content is a model that chose to say
    // nothing. No budget was exhausted, so removing the thinking phase addresses
    // nothing and would cost a second upstream call on every such answer.
    const { seen, spy } = stubFetch(() => ({
      body: { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
    }));
    try {
      await chat();
      expect(seen).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * @regression   11.41.0 — the successful retry returned ONLY its own `LlmResponse`,
   *   so the starved call's usage was dropped. That call is the expensive one: it
   *   burned the entire `max_tokens` allowance by definition. `CoreAiService`
   *   accumulates solely from what `chat()` returns, the total becomes the audit
   *   record's `totalTokens`, and `CoreAiBudgetService` enforces `ai.budget` from
   *   exactly that field — so on a model that starves on every call, a token limit
   *   was enforced against roughly a quarter of the real spend.
   * @seen-failing Return `retried` instead of the merged object from the retry in
   *   src/core/modules/ai/providers/openai-compatible.provider.ts — registered as
   *   mutation `ai-retry-usage-not-merged` in tests/regression-mutations.json.
   */
  it('bills BOTH calls: the retry response carries the starved call usage too', async () => {
    const { spy } = stubFetch((body) => ({ body: body.reasoning_effort ? answered : starved }));
    try {
      const result = await chat();
      // 900 (thinking, thrown away) + 67 (the answer that was actually used).
      expect(result.usage?.completionTokens).toBe(967);
      // The same prompt was genuinely sent — and charged — twice.
      expect(result.usage?.promptTokens).toBe(600);
      expect(result.usage?.reasoningTokens).toBe(900);
      // Neither fixture reports `total_tokens`; an absent field must stay absent
      // rather than be invented as 0, which would read as "measured, and it is zero".
      expect(result.usage?.totalTokens).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * @regression   11.41.0 — the retry was given the FULL `timeoutMs` again instead of
   *   what remained of it, with its own `AbortSignal.timeout`. One `chat()` could then
   *   hold a socket for twice the per-call timeout. `ai.maxRunMs` cannot absorb that:
   *   `CoreAiService` checks it between agent-loop iterations, never mid-call, so the
   *   documented `maxIterations x per-call timeout` ceiling silently doubled.
   * @seen-failing Replace the remaining-budget calculation with the full `timeoutMs`
   *   in src/core/modules/ai/providers/openai-compatible.provider.ts — registered as
   *   mutation `ai-retry-fresh-timeout` in tests/regression-mutations.json.
   */
  it('gives the retry what is LEFT of the timeout, not a fresh one', async () => {
    const budgets: number[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(((ms: number) => {
      budgets.push(ms);
      return new AbortController().signal;
    }) as never);
    const { spy } = stubFetch((body) => ({ body: body.reasoning_effort ? answered : starved }));
    // The first call has to consume measurable time, or "full budget" and "remaining
    // budget" are indistinguishable.
    const slow = spy.getMockImplementation() as (...args: any[]) => Promise<Response>;
    spy.mockImplementation((async (...args: any[]) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return slow(...args);
    }) as never);
    try {
      await new OpenAiCompatibleProvider(connection).chat([{ content: 'hi', role: 'user' }], [], {
        maxTokens: 900,
        timeoutMs: 5000,
      });
      expect(budgets).toHaveLength(2);
      expect(budgets[0]).toBe(5000);
      expect(budgets[1]).toBeLessThan(5000);
      expect(budgets[1]).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  it('does not retry at all when the first call consumed the whole budget', async () => {
    const { seen, spy } = stubFetch(() => ({ body: starved }));
    const slow = spy.getMockImplementation() as (...args: any[]) => Promise<Response>;
    spy.mockImplementation((async (...args: any[]) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return slow(...args);
    }) as never);
    try {
      // 20 ms budget, ~40 ms spent: a second call could only run into its own timeout
      // and would then be reported as "the model rejects reasoning_effort".
      const result = await new OpenAiCompatibleProvider(connection).chat([{ content: 'hi', role: 'user' }], [], {
        maxTokens: 900,
        timeoutMs: 20,
      });
      expect(seen).toHaveLength(1);
      expect(result.finishReason).toBe('length');
      expect(result.usage?.completionTokens).toBe(900);
    } finally {
      spy.mockRestore();
    }
  });

  it('names the ACTUAL retry failure in the log instead of asserting a rejected parameter', async () => {
    // The retry's catch also sees timeouts and transport errors. Claiming "does not
    // accept reasoning_effort" for those points the reader at a cause that is not
    // there — the exact misdirection this change exists to remove.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { spy } = stubFetch((body) => {
      if (body.reasoning_effort) {
        throw new Error('socket hang up');
      }
      return { body: starved };
    });
    try {
      const result = await chat();
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('socket hang up');
      expect(result.text).toBe('');
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('reports finish_reason and the token breakdown so the cause is visible in the log', async () => {
    // The failure was invisible for exactly this reason: the log said "empty",
    // never whether the budget ran out or nothing was produced.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { spy } = stubFetch(() => ({ body: starved }));
    try {
      await chat();
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('length');
      expect(logged).toContain('900');
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});
