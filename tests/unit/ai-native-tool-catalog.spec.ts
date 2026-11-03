import { afterEach, describe, expect, it, vi } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { IAiTool } from '../../src/core/modules/ai/interfaces/ai-tool.interface';
import { ILlmProvider, LlmMessage, LlmResponse } from '../../src/core/modules/ai/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '../../src/core/modules/ai/providers/llm-provider.factory';
import { CoreAiPromptBuilderService } from '../../src/core/modules/ai/services/core-ai-prompt-builder.service';
import { CoreAiService } from '../../src/core/modules/ai/services/core-ai.service';
import { AiToolRegistry } from '../../src/core/modules/ai/tools/ai-tool.registry';

/**
 * The tool catalog in the system prompt and the context budget (12.3.0).
 *
 * A NATIVE connection receives every tool's description and JSON schema through the `tools` payload. The system
 * prompt repeated both in its catalog, so each tool was paid for twice. The catalog now lists names only for a native
 * connection in auto mode (`ai.nativeToolCatalog: 'full'` restores it); emulated connections and plan mode keep the
 * full catalog, their only source of tool descriptions.
 *
 * The context budget counted the system prompt but not the native tool payload, and a system prompt that left the
 * conversation no room was noticed by nobody: the user's message was truncated and logged on debug. The payload now
 * counts against the budget, and a crowded context is reported once per connection.
 */

const description =
  'Delete a record of the active space. Only the owner of the record may delete it; the deletion cannot be undone.';

function tool(name: string): IAiTool {
  return {
    description,
    execute: async () => ({ success: true }),
    name,
    parameters: { properties: { id: { description: 'The record id', type: 'string' } }, type: 'object' },
    roles: [RoleEnum.S_USER],
  };
}

const user = { id: 'user-1', roles: [RoleEnum.ADMIN] };

function configure(ai: Record<string, unknown>) {
  ConfigService.setConfig({ ai } as any, { reInit: true });
}

class FinalAnswerProvider implements ILlmProvider {
  readonly capabilities: ILlmProvider['capabilities'];
  readonly name = 'fake';
  readonly received: { messages: LlmMessage[]; tools: unknown[] }[] = [];

  constructor(nativeTools: boolean) {
    this.capabilities = { jsonResponse: false, nativeTools, systemPrompt: true };
  }

  async chat(messages: LlmMessage[], tools: unknown[]): Promise<LlmResponse> {
    this.received.push({ messages: messages.map((m) => ({ ...m })), tools });
    return {
      text: this.capabilities.nativeTools ? 'done' : JSON.stringify({ final: 'done' }),
      usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
    };
  }
}

function buildService(provider: ILlmProvider, registry: AiToolRegistry, connection: Record<string, unknown> = {}) {
  const factory = new LlmProviderFactory();
  factory.registerBuilder('fake', () => provider);
  const connectionService = {
    resolve: async () => ({
      apiKey: '',
      baseUrl: 'http://fake',
      id: 'conn-1',
      model: 'fake',
      name: 'Fake',
      providerType: 'fake',
      ...connection,
    }),
  } as any;
  return new CoreAiService(connectionService, factory, registry, new CoreAiPromptBuilderService());
}

describe('tool catalog in the system prompt', () => {
  afterEach(() => configure({}));

  /**
   * @regression   12.3.0 — a native connection got every description (and, without deferToolSchemas, every schema)
   *   twice: in the tool payload and in the system prompt's catalog.
   * @seen-failing Render the full catalog for native connections in renderContext()
   *   (src/core/modules/ai/services/core-ai-prompt-builder.service.ts) — registered as mutation
   *   `ai-native-catalog-duplicated` in tests/regression-mutations.json.
   */
  it('lists only the names for a native connection, with or without deferred schemas', async () => {
    const builder = new CoreAiPromptBuilderService();
    for (const deferToolSchemas of [false, true]) {
      configure({ deferToolSchemas });

      const prompt = await builder.buildSystemPrompt([tool('delete_record'), tool('find_records')], true, user);

      expect(prompt).toContain('- delete_record\n- find_records');
      expect(prompt).not.toContain('Delete a record');
      expect(prompt).not.toContain('JSON schema');
    }
  });

  it("restores the full catalog for native connections with ai.nativeToolCatalog: 'full'", async () => {
    configure({ nativeToolCatalog: 'full' });

    const prompt = await new CoreAiPromptBuilderService().buildSystemPrompt([tool('delete_record')], true, user);

    expect(prompt).toContain(`- delete_record: ${description}`);
    expect(prompt).toContain('parameters (JSON schema)');
  });

  it('keeps the full catalog for emulated connections and in plan mode', async () => {
    const builder = new CoreAiPromptBuilderService();

    const emulated = await builder.buildSystemPrompt([tool('delete_record')], false, user);
    const plan = await builder.buildPlanSystemPrompt([tool('delete_record')], user);

    expect(emulated).toContain(`- delete_record: ${description}`);
    expect(plan).toContain(`- delete_record: ${description}`);
  });

  it('still sends the full descriptions and schemas in the native tool payload', async () => {
    const registry = new AiToolRegistry();
    registry.register(tool('delete_record'));
    const provider = new FinalAnswerProvider(true);

    await buildService(provider, registry).prompt({ prompt: 'hi' } as any, { currentUser: user });

    expect(provider.received[0].tools).toContainEqual(
      expect.objectContaining({ description, name: 'delete_record', parameters: expect.any(Object) }),
    );
  });
});

describe('context budget and a crowded context window', () => {
  afterEach(() => configure({}));

  /**
   * @regression   12.3.0 — the native tool payload occupies the context window but was not counted, so the history
   *   was kept until the provider overflowed or cut the input itself.
   * @seen-failing Ignore `reservedTokens` in messageBudget()
   *   (src/core/modules/ai/services/core-ai.service.ts) — registered as mutation
   *   `ai-native-tools-not-in-budget` in tests/regression-mutations.json.
   */
  it('counts the native tool definitions against the input budget', () => {
    const service = buildService(new FinalAnswerProvider(true), new AiToolRegistry()) as any;
    const connection = { contextWindow: 4096, defaultMaxTokens: 512 };
    const history = (): LlmMessage[] => [
      { content: 'system', role: 'system' },
      { content: 'x'.repeat(4000), role: 'user' },
      { content: 'x'.repeat(4000), role: 'assistant' },
      { content: 'latest question', role: 'user' },
    ];

    const without = history();
    service.fitMessagesToContext(without, connection);
    expect(without).toHaveLength(4);

    const withTools = history();
    service.fitMessagesToContext(withTools, connection, 2000);
    expect(withTools.length).toBeLessThan(4);
    expect(withTools.at(-1).content).toBe('latest question');
  });

  /**
   * @regression   12.3.0 — the native tool payload was not counted against the budget of a real run; with the
   *   descriptions gone from the catalog, a native connection would undercount by the whole payload.
   * @seen-failing Pass no tool tokens from runAuto()
   *   (src/core/modules/ai/services/core-ai.service.ts) — registered as mutation
   *   `ai-run-ignores-native-tool-tokens` in tests/regression-mutations.json.
   */
  it('reserves the native tool payload in a real run, so the messages are fitted to what remains', async () => {
    const registry = new AiToolRegistry();
    for (let i = 0; i < 80; i++) {
      registry.register(tool(`tool_${i}`));
    }
    const provider = new FinalAnswerProvider(true);
    const service = buildService(provider, registry);
    vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await service.prompt({ prompt: 'x'.repeat(12000) } as any, { currentUser: user });

    expect(provider.received[0].messages.at(-1).content).toContain('[truncated to fit the context window]');
  });

  /**
   * @regression   12.3.0 — a system prompt that left the conversation no room truncated the user's message and was
   *   logged on debug only; nobody saw why the assistant answered generically.
   * @seen-failing Skip the crowded-context check in runAuto()
   *   (src/core/modules/ai/services/core-ai.service.ts) — registered as mutation
   *   `ai-crowded-context-silent` in tests/regression-mutations.json.
   */
  it('warns once per connection when the system prompt and tools crowd the context window', async () => {
    const registry = new AiToolRegistry();
    for (let i = 0; i < 80; i++) {
      registry.register(tool(`tool_${i}`));
    }
    const service = buildService(new FinalAnswerProvider(false), registry);
    const warn = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await service.prompt({ prompt: 'hi' } as any, { currentUser: user });
    await service.prompt({ prompt: 'again' } as any, { currentUser: user });

    const crowded = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('context window'));
    expect(crowded).toHaveLength(1);
    expect(crowded[0]).toContain('"Fake"');
    expect(crowded[0]).toContain('ai.contextWindow fallback');
  });

  it('stays quiet when the context window has room', async () => {
    const registry = new AiToolRegistry();
    registry.register(tool('delete_record'));
    const service = buildService(new FinalAnswerProvider(true), registry, { contextWindow: 131072 });
    const warn = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await service.prompt({ prompt: 'hi' } as any, { currentUser: user });

    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('context window'))).toEqual([]);
  });
});
