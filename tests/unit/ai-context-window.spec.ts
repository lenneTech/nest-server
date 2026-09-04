import { describe, expect, it } from 'vitest';

import { ResolvedAiConnection } from '../../src/core/modules/ai/interfaces/resolved-ai-connection.interface';
import { OpenAiCompatibleProvider } from '../../src/core/modules/ai/providers/openai-compatible.provider';

/**
 * Context-window heuristics. Many OpenAI-compatible endpoints report no
 * `max_model_len` on `/v1/models`, so this table is all that stands between a
 * connection and the conservative 8192 default that makes the orchestrator trim the system
 * prompt every turn.
 */
describe('OpenAiCompatibleProvider.knownContextWindow', () => {
  /** `knownContextWindow` is protected — reach it the way a subclass would. */
  class Probe extends OpenAiCompatibleProvider {
    windowFor(model: string): number | undefined {
      return this.knownContextWindow(model);
    }
  }

  const probe = new Probe({ baseUrl: 'https://llm.example.test/v1', id: 'c', model: 'x' } as ResolvedAiConnection);

  it.each([
    // Verified on 2026-07-25 by sending prompts of known size until rejection:
    // Ministral / Mistral-Medium / Qwen3.x accepted ~163k tokens, gpt-oss did not.
    ['Ministral-3-14B-Instruct-2512', 131_072],
    ['Mistral-Medium-3.5-128B', 131_072],
    ['Qwen3.6-35B-A3B-FP8', 131_072],
    ['Qwen3.5-122B-A10B-FP8', 131_072],
  ])('resolves %s to at least %i tokens', (model, atLeast) => {
    expect(probe.windowFor(model)).toBeGreaterThanOrEqual(atLeast);
  });

  it('does not fall back to the small legacy Mistral window for a modern Mistral model', () => {
    // The generic `mistral` → 32768 entry predates Mistral Medium 3.5 (256k) and
    // would cap it at an eighth of its real window.
    expect(probe.windowFor('Mistral-Medium-3.5-128B')).not.toBe(32_768);
  });

  it('keeps the conservative window for genuinely small legacy models', () => {
    expect(probe.windowFor('mistral-7b-instruct-v0.2')).toBe(32_768);
  });
});
