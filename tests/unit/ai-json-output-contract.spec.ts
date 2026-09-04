import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreAiService } from '../../src/core/modules/ai/services/core-ai.service';

/**
 * The assistant answered a plain question with a raw JSON blob.
 *
 * Two independent defects produced it, and both are pinned here.
 *
 * **1. JSON mode was forced on a prompt that asks for prose.**
 * `response_format: {type:'json_object'}` is attached per CONNECTION
 * (`supportsJsonResponse`), but whether the answer must be JSON is a property of the
 * PROMPT. The JSON output contract lives in the `output_contract` /
 * `tool_protocol_emulated` fragments — both `capability: 'emulated'` — plus
 * `plan_protocol`. A NATIVE-tools connection therefore gets neither, is asked for
 * prose, and is handed no JSON shape to fill. Forcing JSON on top is a contradiction
 * the model can only resolve by inventing a shape of its own.
 *
 * Measured against an OpenAI-compatible hosting endpoint
 * (`Mistral-Medium-3.5-128B`, 2026-09-03), varying only `response_format` and the
 * offered tools:
 *
 * | protocol | response_format | answer                                                  |
 * |----------|-----------------|---------------------------------------------------------|
 * | native   | on              | `{"answer":"A clear sky is blue."}` — and, when tools are |
 * |          |                 | offered, `{"name":"<a_tool>","parameters":{}}` in      |
 * |          |                 | `content` with NO native `tool_calls` at all              |
 * | native   | off             | `A clear sky is blue.` + real `tool_calls`                |
 * | emulated | on              | `{"tool_calls":[…]}`                                      |
 * | emulated | off             | `{"tool_calls":[…]}`                                      |
 *
 * So JSON mode is harmful in exactly one cell — native — and both emulated cells
 * work. Hence: follow the contract, do not disable the flag wholesale (which would
 * have cost the emulated protocol its deterministic parse for no gain).
 *
 * **2. A bare JSON object was handed to the user verbatim.** The final-answer branch
 * dropped only `tool_calls` / `final`-shaped objects; anything else parsed by
 * `extractJsonObject` fell through to `finalText = completion.text`. That is how the
 * observed `{"success":true,"data":{"records":[…]}}` — real records, real ids —
 * reached the chat panel. Defence in depth: with (1) fixed the model is no longer
 * pushed off-contract, but nothing stops it wandering there on its own.
 */
describe('CoreAiService — JSON mode follows the output contract', () => {
  const connection = {
    apiKey: 'k',
    baseUrl: 'https://llm.example.com/v1',
    contextWindow: 128_000,
    id: 'c1',
    model: 'connection-model',
    providerType: 'openai-compatible',
    supportsJsonResponse: true,
  } as any;

  beforeEach(() => {
    // Keep the agent loop short so a test that never produces a final answer ends
    // on the fallback rather than on the default ceiling.
    ConfigService.setConfig({ ai: { maxIterations: 3 } } as any, { reInit: true });
  });

  /**
   * A service with only the collaborators `runAuto` / `runPlan` actually reach.
   * `chat` is queued per call so a test can drive several loop iterations.
   */
  function makeService(replies: { text: string; toolCalls?: any[]; truncated?: boolean }[], nativeTools: boolean) {
    const created: any[] = [];
    const chatCalls: { conn: any; messages: any[]; options?: any }[] = [];
    let next = 0;
    const providerFactory: any = {
      create: vi.fn((conn: any) => {
        created.push(conn);
        return {
          capabilities: { jsonResponse: !!conn.supportsJsonResponse, nativeTools, systemPrompt: true },
          chat: vi.fn(async (messages: any[], _tools: any[], options: any) => {
            chatCalls.push({ conn, messages: [...messages], options });
            const reply = replies[Math.min(next++, replies.length - 1)];
            return {
              // `raw` mirrors the provider's own shape so `hitOutputCeiling` is
              // exercised rather than stubbed away.
              raw: { choices: [{ finish_reason: reply.truncated ? 'length' : 'stop' }] },
              text: reply.text,
              toolCalls: reply.toolCalls,
              usage: {},
            };
          }),
        };
      }),
    };

    const service: any = Object.create(CoreAiService.prototype);
    service.providerFactory = providerFactory;
    service.logger = { debug: vi.fn(), warn: vi.fn() };
    service.promptBuilder = {
      buildPlanSystemPrompt: vi.fn().mockResolvedValue('PLAN SYSTEM'),
      buildSystemPrompt: vi.fn().mockResolvedValue('SYSTEM'),
      buildToolSchemas: vi.fn().mockReturnValue([]),
    };
    // Not on this path — compaction and trimming have their own specs.
    service.compactMessages = vi.fn().mockResolvedValue(0);
    service.fitMessagesToContext = vi.fn();
    service.audit = vi.fn().mockResolvedValue(undefined);

    // The provider `prepareRun` would have built: the connection as stored.
    const provider = providerFactory.create(connection);
    created.length = 0; // that one is setup, not part of what the run decided
    chatCalls.length = 0;

    const run: any = {
      connection,
      context: {},
      currentUser: undefined,
      history: [],
      language: 'en',
      provider,
      tenantId: 't1',
      tools: [],
    };
    return { chatCalls, created, run, service };
  }

  describe('native tool calling — the prompt asks for prose', () => {
    it('narrows JSON mode off for the call, without rebuilding the provider', async () => {
      const { chatCalls, created, run, service } = makeService([{ text: 'You have 42 contacts.' }], true);

      const response = await service.runAuto({ prompt: 'How many contacts do I have?' }, run);

      expect(response.text).toBe('You have 42 contacts.');
      expect(chatCalls[0].options).toMatchObject({ jsonResponse: false });
      // The run's own provider is used — no second instance is built for this.
      expect(created).toHaveLength(0);
    });
  });

  describe('emulated tool calling — the prompt demands JSON only', () => {
    it('keeps JSON mode on, so the protocol parse stays deterministic', async () => {
      const { chatCalls, created, run, service } = makeService([{ text: '{"final":"You have 42 contacts."}' }], false);

      const response = await service.runAuto({ prompt: 'How many contacts do I have?' }, run);

      expect(response.text).toBe('You have 42 contacts.');
      expect(created).toHaveLength(0);
      // No narrowing: the emulated contract demands JSON, so the connection flag stands.
      expect(chatCalls[0].options?.jsonResponse).toBeUndefined();
    });

    it('still parses an emulated tool call — no regression in the protocol path', async () => {
      const { run, service } = makeService(
        [{ text: '{"tool_calls":[{"name":"find_records","arguments":{}}]}' }, { text: '{"final":"Found them."}' }],
        false,
      );
      run.tools = [{ description: 'Find records', name: 'find_records', parameters: {} }];
      service.evaluateToolPolicies = vi.fn().mockResolvedValue({ asked: [], denied: [] });
      service.executeToolCall = vi
        .fn()
        .mockResolvedValue({ name: 'find_records', result: { count: 42 }, success: true });
      service.extractAskUserQuestion = vi.fn().mockReturnValue(undefined);

      const response = await service.runAuto({ prompt: 'How many contacts?' }, run);

      expect(service.executeToolCall).toHaveBeenCalledTimes(1);
      expect(response.text).toBe('Found them.');
    });
  });

  describe('a bare JSON object never reaches the user', () => {
    it("nudges in the wording of the run's OWN contract", async () => {
      // This branch mutated green: both nudge tests asserted only the final text, so
      // inverting the condition — telling an emulated run to drop the JSON its own
      // output contract demands — changed nothing observable.
      const native = makeService([{ text: '{"success":true}' }, { text: 'Two contacts.' }], true);
      await native.service.runAuto({ prompt: 'How many?' }, native.run);
      expect(native.chatCalls[1].messages.at(-1).content).toContain('plain natural language');

      const emulated = makeService([{ text: '{"success":true}' }, { text: '{"final":"Two contacts."}' }], false);
      await emulated.service.runAuto({ prompt: 'How many?' }, emulated.run);
      expect(emulated.chatCalls[1].messages.at(-1).content).toContain('{"final"');
    });

    it('does not feed the off-contract output back as an accepted assistant turn', async () => {
      // The tool-call path 45 lines above refuses exactly this ("never the raw text,
      // which may carry […] a model-hallucinated TOOL_RESULTS block"). Re-admitting a
      // fabricated blob would let the next answer be grounded in data no tool returned.
      const blob = '{"success":true,"data":{"contacts":[{"displayName":"Anna Beispiel"}]}}';
      const { chatCalls, run, service } = makeService([{ text: blob }, { text: 'One contact.' }], true);

      await service.runAuto({ prompt: 'How many?' }, run);

      const secondTurn = chatCalls[1].messages;
      expect(JSON.stringify(secondTurn)).not.toContain('Anna Beispiel');
    });

    it('nudges once, then answers with the nudged prose', async () => {
      const { run, service } = makeService(
        [
          { text: '{"success":true,"data":{"contacts":[{"id":"6a5699411a0d15","displayName":"Anna Beispiel"}]}}' },
          { text: 'You have one contact: Anna Beispiel.' },
        ],
        true,
      );

      const response = await service.runAuto({ prompt: 'How many contacts do I have?' }, run);

      expect(response.text).toBe('You have one contact: Anna Beispiel.');
      expect(response.text).not.toContain('displayName');
      expect(response.iterations).toBe(2);
    });

    it('falls back to the generic message when the model keeps answering in JSON', async () => {
      const { run, service } = makeService(
        [{ text: '{"name":"find_records","parameters":{}}' }, { text: '{"success":false,"error":{"code":"X"}}' }],
        true,
      );

      const response = await service.runAuto({ prompt: 'How many contacts do I have?' }, run);

      // Never the raw blob — the translated fallback instead.
      expect(response.text).not.toContain('find_records');
      expect(response.text).not.toContain('success');
      expect(response.text).toBe(service.translate('no_final_answer', 'en'));
    });

    it('blocks a bare ARRAY — the same records, one bracket away', async () => {
      const arr = '[{"id":"6a5699411a0d15","displayName":"Anna Beispiel"}]';
      const { run, service } = makeService([{ text: arr }, { text: 'One contact: Anna Beispiel.' }], true);

      const response = await service.runAuto({ prompt: 'Which contacts?' }, run);

      expect(response.text).toBe('One contact: Anna Beispiel.');
      expect(response.text).not.toContain('displayName');
    });

    it('blocks a TRUNCATED payload — the likeliest shape of an echoed tool result', async () => {
      // Tool results are long, so they hit the output ceiling before they close.
      // The observed symptom string was itself cut off mid-object.
      const cut = '{"success":true,"data":{"contacts":[{"id":"6a5699411a0d15","displayName":"Anna Beis';
      const { run, service } = makeService([{ text: cut, truncated: true }, { text: 'One contact.' }], true);

      const response = await service.runAuto({ prompt: 'Which contacts?' }, run);

      expect(response.text).toBe('One contact.');
      expect(response.text).not.toContain('displayName');
    });

    it('passes UNPARSEABLE prose that merely opens with a brace', async () => {
      // Not truncated, so not residue: this is an answer that happens to start with
      // a brace. Suppressing it would trade one false negative for another.
      const prose = '{Platzhalter} wird beim Versand durch den Namen ersetzt.';
      const { run, service } = makeService([{ text: prose }], true);

      expect((await service.runAuto({ prompt: 'Was ist das?' }, run)).text).toBe(prose);
    });

    it('blocks a FENCED protocol wrapper — no user asks for the wire format', async () => {
      // The predecessor guard caught this via the lenient extractor, which strips
      // fences. Replacing it with a bare-only check silently un-fixed the very case
      // its own comment named.
      const fenced = '```json\n{"tool_calls":[]}\n```';
      const { run, service } = makeService([{ text: fenced }, { text: 'Nothing to do.' }], true);

      const response = await service.runAuto({ prompt: 'Do nothing' }, run);

      expect(response.text).toBe('Nothing to do.');
      expect(response.text).not.toContain('tool_calls');
    });

    it('falls back rather than rendering an empty bubble on a whitespace-only answer', async () => {
      const { run, service } = makeService([{ text: '   \n  ' }], true);

      const response = await service.runAuto({ prompt: 'Hi' }, run);

      expect(response.text).toBe(service.translate('no_final_answer', 'en'));
    });

    it('passes a FENCED JSON block through — that is an answer the user asked for', async () => {
      const fenced = '```json\n{"answer":42}\n```';
      const { run, service } = makeService([{ text: fenced }], true);

      const response = await service.runAuto({ prompt: 'Show me the raw JSON' }, run);

      expect(response.text).toBe(fenced);
    });

    it('passes prose that merely contains JSON through untouched', async () => {
      const prose = 'The stored payload is {"limit":100} — nothing else is set.';
      const { run, service } = makeService([{ text: prose }], true);

      const response = await service.runAuto({ prompt: 'What is stored?' }, run);

      expect(response.text).toBe(prose);
    });
  });
  describe('plan mode', () => {
    it('keeps JSON for the plan call and asks the SUMMARY call for prose', async () => {
      // 1st call = the plan (JSON contract), 2nd = the summary (no JSON contract:
      // `buildPlanSystemPrompt` drops `output_contract`).
      const { chatCalls, run, service } = makeService(
        [{ text: '{"plan":[],"summary":"Nothing to do."}' }, { text: 'There was nothing to do.' }],
        true,
      );
      service.baseResponse = (connectionId: string) => ({ connectionId }) as any;
      service.persistTurn = vi.fn().mockResolvedValue(undefined);
      service.auditRecord = vi.fn().mockReturnValue({});

      const response = await service.runPlan({ prompt: 'Do nothing' }, run);

      expect(chatCalls).toHaveLength(2);
      expect(chatCalls[0].options?.jsonResponse).toBeUndefined();
      expect(chatCalls[1].options).toMatchObject({ jsonResponse: false });
      expect(response.text).toBe('There was nothing to do.');
    });
  });
});
