import { createHash } from 'node:crypto';
import { vi } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { IAiTool } from '../../src/core/modules/ai/interfaces/ai-tool.interface';
import { ILlmProvider, LlmResponse } from '../../src/core/modules/ai/interfaces/llm-provider.interface';
import { ClaudeCliProvider } from '../../src/core/modules/ai/providers/claude-cli.provider';
import { LlmProviderFactory } from '../../src/core/modules/ai/providers/llm-provider.factory';
import { OpenAiCompatibleProvider } from '../../src/core/modules/ai/providers/openai-compatible.provider';
import { AiCryptoService } from '../../src/core/modules/ai/services/ai-crypto.service';
import { CoreAiBudgetService } from '../../src/core/modules/ai/services/core-ai-budget.service';
import { CoreAiConnectionResolverService } from '../../src/core/modules/ai/services/core-ai-connection-resolver.service';
import { CoreAiMcpController } from '../../src/core/modules/ai/core-ai-mcp.controller';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { CoreAiMcpService } from '../../src/core/modules/ai/services/core-ai-mcp.service';
import { CoreAiPromptBuilderService } from '../../src/core/modules/ai/services/core-ai-prompt-builder.service';
import { CoreAiService } from '../../src/core/modules/ai/services/core-ai.service';
import { AiToolRegistry } from '../../src/core/modules/ai/tools/ai-tool.registry';

/** Minimal tool factory for tests. */
function makeTool(name: string, roles: (RoleEnum | string)[], execute?: IAiTool['execute']): IAiTool {
  return {
    description: `tool ${name}`,
    execute: execute ?? (async () => ({ success: true })),
    name,
    parameters: { properties: {}, type: 'object' },
    roles,
  };
}

/** Fake provider returning scripted responses per call. */
class ScriptedProvider implements ILlmProvider {
  readonly capabilities = { jsonResponse: false, nativeTools: false, systemPrompt: true };
  readonly name = 'fake';
  private call = 0;

  constructor(private readonly scripts: string[]) {}

  async chat(): Promise<LlmResponse> {
    const text = this.scripts[Math.min(this.call, this.scripts.length - 1)];
    this.call++;
    return { text, usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 } };
  }
}

describe('AiCryptoService', () => {
  beforeAll(() => {
    // Initialize the static config so crypto can read ai.encryptionSecret.
    new ConfigService({ ai: { encryptionSecret: 'unit-test-secret-key-please-32-chars' } } as any);
  });

  it('roundtrips a secret as an iv.tag.ciphertext triplet', () => {
    const crypto = new AiCryptoService();
    const enc = crypto.encrypt('sk-super-secret');
    expect(enc).not.toBe('sk-super-secret');
    expect(enc.split('.')).toHaveLength(3);
    expect(crypto.decrypt(enc)).toBe('sk-super-secret');
  });

  it('preserves empty values (set vs. never-set semantics)', () => {
    const crypto = new AiCryptoService();
    expect(crypto.encrypt('')).toBe('');
    expect(crypto.decrypt('')).toBe('');
  });

  it('assertProductionSafe throws in production without a secret, allows it otherwise', () => {
    const savedNsc = process.env.NSC__AI__ENCRYPTION_SECRET;
    const savedSec = process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.NSC__AI__ENCRYPTION_SECRET;
    delete process.env.SECRETS_ENCRYPTION_KEY;
    try {
      const crypto = new AiCryptoService();
      // production + no secret → throws (reInit replaces config, not merge)
      ConfigService.setConfig({ ai: {}, env: 'production' } as any, { reInit: true });
      expect(() => crypto.assertProductionSafe()).toThrow(/encryption secret is required/i);
      // staging is also production-like
      ConfigService.setConfig({ ai: {}, env: 'staging' } as any, { reInit: true });
      expect(() => crypto.assertProductionSafe()).toThrow();
      // production + secret → ok
      ConfigService.setConfig(
        { ai: { encryptionSecret: 'a-strong-secret-value-1234567890-abc' }, env: 'production' } as any,
        { reInit: true },
      );
      expect(() => crypto.assertProductionSafe()).not.toThrow();
      // non-production + no secret → ok (dev default + warning is acceptable)
      ConfigService.setConfig({ ai: {}, env: 'local' } as any, { reInit: true });
      expect(() => crypto.assertProductionSafe()).not.toThrow();
    } finally {
      if (savedNsc !== undefined) {
        process.env.NSC__AI__ENCRYPTION_SECRET = savedNsc;
      }
      if (savedSec !== undefined) {
        process.env.SECRETS_ENCRYPTION_KEY = savedSec;
      }
      ConfigService.setConfig({ ai: { encryptionSecret: 'unit-test-secret-key-please-32-chars' } } as any, {
        reInit: true,
      });
    }
  });
});

describe('AiToolRegistry', () => {
  it('filters tools by the user roles', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool('pub', [RoleEnum.S_EVERYONE]));
    registry.register(makeTool('user', [RoleEnum.S_USER]));
    registry.register(makeTool('admin', [RoleEnum.ADMIN]));
    registry.register(makeTool('locked', [RoleEnum.S_NO_ONE]));

    expect(registry.forUser(null).map((t) => t.name)).toEqual(['pub']);
    expect(
      registry
        .forUser({ id: '1', roles: [] })
        .map((t) => t.name)
        .sort(),
    ).toEqual(['pub', 'user']);

    const adminTools = registry.forUser({ id: '2', roles: [RoleEnum.ADMIN] }).map((t) => t.name);
    expect(adminTools).toContain('admin');
    expect(adminTools).not.toContain('locked');
  });

  it('overrides a tool registered under the same name (last write wins)', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool('t', [RoleEnum.S_EVERYONE]));
    const replacement = makeTool('t', [RoleEnum.S_EVERYONE]);
    registry.register(replacement);
    expect(registry.get('t')).toBe(replacement);
    expect(registry.all()).toHaveLength(1);
  });
});

describe('CoreAiPromptBuilderService (enrichment)', () => {
  it('enriches the system prompt with the user permissions, tools and documentation', async () => {
    new ConfigService({ ai: { documentation: 'DOC-MARKER-123', systemPrompt: 'BASE-PROMPT' } } as any);
    const builder = new CoreAiPromptBuilderService();
    const prompt = await builder.buildSystemPrompt([makeTool('do_thing', [RoleEnum.S_USER])], false, {
      id: 'u1',
      roles: ['admin', 'editor'],
    });
    expect(prompt).toContain('BASE-PROMPT');
    expect(prompt).toContain('DOC-MARKER-123');
    expect(prompt).toContain('admin');
    expect(prompt).toContain('editor');
    expect(prompt).toContain('do_thing');
  });

  it('includes anti-hallucination + error guidance and renders the tool catalog', async () => {
    new ConfigService({ ai: {} } as any);
    const builder = new CoreAiPromptBuilderService();
    const prompt = await builder.buildSystemPrompt([makeTool('count_users', [RoleEnum.S_USER])], false, {
      id: 'u1',
      roles: [],
    });
    expect(prompt).toMatch(/NEVER invent|guess/i);
    expect(prompt).toContain('count_users');
    expect(prompt).toMatch(/success.*false|error/i);
    expect(prompt).toContain('{"final"');
  });

  it('omits tool protocol when the user has no tools', async () => {
    new ConfigService({ ai: {} } as any);
    const builder = new CoreAiPromptBuilderService();
    const prompt = await builder.buildSystemPrompt([], false, { id: 'u1', roles: [] });
    expect(prompt).not.toContain('tool_calls');
    expect(prompt).toContain('available tools (you may ONLY use these): none');
  });

  it('applies admin template overrides and injects approved learned hints', async () => {
    new ConfigService({ ai: {} } as any);
    const fakeTemplates = {
      resolveFragments: async () => [
        { content: 'OVERRIDDEN-BASE-XYZ', key: 'base', order: 10 },
        { content: 'Learned guidance:\n{{learnedHints}}', key: 'learned_hints', order: 80 },
      ],
    } as any;
    const fakeHints = { approvedHints: async () => ['Always double-check ids before acting.'] } as any;
    const builder = new CoreAiPromptBuilderService(fakeTemplates, fakeHints);
    const prompt = await builder.buildSystemPrompt([], false, { id: 'u1', roles: [] });
    expect(prompt).toContain('OVERRIDDEN-BASE-XYZ');
    expect(prompt).toContain('Always double-check ids before acting.');
  });

  it('passes the active scopes (tool:* + role:* + mode:*) to the template service for scoped overrides', async () => {
    new ConfigService({ ai: {} } as any);
    const seen: string[][] = [];
    const fakeTemplates = {
      resolveFragments: async (_defaults: any, opts: any) => {
        seen.push(opts?.scopes || []);
        return [];
      },
    } as any;
    const builder = new CoreAiPromptBuilderService(fakeTemplates);
    await builder.buildSystemPrompt(
      [makeTool('get_user', [RoleEnum.S_USER]), makeTool('find_users', [RoleEnum.S_USER])],
      false,
      { id: 'u1', roles: ['admin', 'editor'] },
      { mode: 'support' },
    );
    expect(seen[0]).toEqual(expect.arrayContaining(['tool:get_user', 'tool:find_users', 'role:admin', 'role:editor', 'mode:support']));
  });

  it('deferred tool-schemas: builder emits only tool names + a search_tools hint when ai.deferToolSchemas=true', async () => {
    ConfigService.setConfig({ ai: { deferToolSchemas: true } } as any, { reInit: true });
    const builder = new CoreAiPromptBuilderService();
    const tools = [
      makeTool('get_user', [RoleEnum.S_USER]),
      makeTool('find_users', [RoleEnum.S_USER]),
    ];
    const prompt = await builder.buildSystemPrompt(tools, false, { id: 'u1', roles: [] });
    // Tool names appear:
    expect(prompt).toContain('get_user');
    expect(prompt).toContain('find_users');
    // Full schema (parameters object) does NOT:
    expect(prompt).not.toContain('"parameters"');
    // search_tools hint is included so the LLM knows how to fetch on demand:
    expect(prompt).toMatch(/search_tools|fetch the tool schema/i);
  });

  it('deferred tool-schemas off (default): full tool catalog is in the prompt', async () => {
    ConfigService.setConfig({ ai: { deferToolSchemas: false } } as any, { reInit: true });
    const builder = new CoreAiPromptBuilderService();
    const tools = [makeTool('get_user', [RoleEnum.S_USER])];
    const prompt = await builder.buildSystemPrompt(tools, false, { id: 'u1', roles: [] });
    expect(prompt).toContain('get_user');
    // Full schema with `parameters` is in the prompt
    expect(prompt).toMatch(/parameters/i);
  });

  it('falls back to in-builder scope filter when no template service is wired', async () => {
    new ConfigService({ ai: {} } as any);
    class Probe extends CoreAiPromptBuilderService {
      override defaultFragments(): any[] {
        return [
          { content: 'GLOBAL', key: 'base', order: 10 },
          { content: 'SUPPORT-ONLY', key: 'support', order: 20, scope: 'mode:support' },
          { content: 'GETUSER-ONLY', key: 'tool_hint', order: 30, scope: 'tool:get_user' },
        ];
      }
    }
    const builder = new Probe();
    const promptWithSupport = await builder.buildSystemPrompt(
      [makeTool('get_user', [RoleEnum.S_USER])],
      false,
      { id: 'u1', roles: [] },
      { mode: 'support' },
    );
    expect(promptWithSupport).toContain('GLOBAL');
    expect(promptWithSupport).toContain('SUPPORT-ONLY');
    expect(promptWithSupport).toContain('GETUSER-ONLY');

    const promptWithoutScopes = await builder.buildSystemPrompt(
      [makeTool('count_users', [RoleEnum.S_USER])],
      false,
      { id: 'u1', roles: [] },
    );
    expect(promptWithoutScopes).toContain('GLOBAL');
    expect(promptWithoutScopes).not.toContain('SUPPORT-ONLY');
    expect(promptWithoutScopes).not.toContain('GETUSER-ONLY');
  });
});

describe('CoreAiService context-window handling (per user/session)', () => {
  class Exposed extends CoreAiService {
    cap(s: string) {
      return this.capToolResults(s);
    }
    fit(messages: any, conn: any) {
      return this.fitMessagesToContext(messages, conn);
    }
  }
  function make() {
    return new Exposed(
      { resolve: async () => ({}) } as any,
      new LlmProviderFactory(),
      new AiToolRegistry(),
      new CoreAiPromptBuilderService(),
    );
  }

  it('trims oldest session turns to fit the context window, keeping system + current', () => {
    new ConfigService({ ai: {} } as any);
    const messages = [
      { content: 'SYSTEM-PROMPT', role: 'system' },
      { content: 'X'.repeat(4000), role: 'user' },
      { content: 'Y'.repeat(4000), role: 'assistant' },
      { content: 'CURRENT-PROMPT', role: 'user' },
    ];
    make().fit(messages, { contextWindow: 1000, defaultMaxTokens: 100 } as any);
    expect(messages[0].content).toBe('SYSTEM-PROMPT');
    expect(messages[messages.length - 1].content).toBe('CURRENT-PROMPT');
    expect(messages.length).toBeLessThan(4);
  });

  it('truncates the most recent message when it alone overflows', () => {
    new ConfigService({ ai: {} } as any);
    const messages = [
      { content: 'SYSTEM', role: 'system' },
      { content: 'Z'.repeat(40_000), role: 'user' },
    ];
    make().fit(messages, { contextWindow: 1000, defaultMaxTokens: 100 } as any);
    expect(messages[1].content).toContain('truncated');
    expect(messages[1].content.length).toBeLessThan(40_000);
  });

  it('caps an oversized tool-results payload', () => {
    new ConfigService({ ai: { maxToolResultChars: 100 } } as any);
    const capped = make().cap('Z'.repeat(500));
    expect(capped.length).toBeLessThan(500);
    expect(capped).toContain('truncated');
  });

  it('LLM-driven compaction replaces oldest turns with a generated summary instead of dropping them', async () => {
    ConfigService.setConfig({ ai: { compaction: true } } as any, { reInit: true });
    // a tiny fake provider used both as the run's main provider AND the small-model
    // compaction provider — it returns a fixed summary on call.
    const fakeProvider: ILlmProvider = {
      capabilities: { jsonResponse: false, nativeTools: false, systemPrompt: true },
      chat: async () => ({ text: 'COMPACTED-SUMMARY-XYZ', usage: { completionTokens: 5, promptTokens: 5, totalTokens: 10 } }),
      name: 'fake',
    };
    class CompactProbe extends CoreAiService {
      async runCompact(messages: any, conn: any) {
        return this.compactMessages(messages, conn);
      }
    }
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => fakeProvider);
    const probe = new CompactProbe(
      { resolve: async () => ({}) } as any,
      factory,
      new AiToolRegistry(),
      new CoreAiPromptBuilderService(),
    );
    const messages = [
      { content: 'SYSTEM-PROMPT', role: 'system' },
      { content: 'OLD-TURN-1 ' + 'a'.repeat(4000), role: 'user' },
      { content: 'OLD-TURN-2 ' + 'b'.repeat(4000), role: 'assistant' },
      { content: 'OLD-TURN-3 ' + 'c'.repeat(4000), role: 'user' },
      { content: 'OLD-TURN-4 ' + 'd'.repeat(4000), role: 'assistant' },
      { content: 'CURRENT-PROMPT', role: 'user' },
    ];
    await probe.runCompact(messages, {
      contextWindow: 1000,
      defaultMaxTokens: 100,
      id: 'c-fake',
      providerType: 'fake',
    } as any);
    // System + Current are preserved.
    expect(messages[0].content).toBe('SYSTEM-PROMPT');
    expect(messages[messages.length - 1].content).toBe('CURRENT-PROMPT');
    // The summary replaces the oldest non-system turns.
    expect(messages.some((m) => m.content?.includes('COMPACTED-SUMMARY-XYZ'))).toBe(true);
    // Original old turns are no longer present verbatim.
    expect(messages.some((m) => m.content === 'OLD-TURN-1')).toBe(false);
  });
});

describe('CoreAiService (emulated tool calling)', () => {
  beforeAll(() => {
    new ConfigService({ ai: { maxIterations: 5 } } as any);
  });

  function buildService(provider: ILlmProvider, registry: AiToolRegistry) {
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
      }),
    } as any;
    return new CoreAiService(connectionService, factory, registry, new CoreAiPromptBuilderService());
  }

  it('runs the agent loop: parses an emulated tool call, executes it, returns the final answer', async () => {
    let executedWith: any = null;
    const registry = new AiToolRegistry();
    registry.register(
      makeTool('count_users', [RoleEnum.ADMIN], async (args, ctx) => {
        executedWith = { args, user: ctx.currentUser?.id };
        return { data: { count: 5 }, success: true };
      }),
    );

    const provider = new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: { scope: 'all' }, name: 'count_users' }] }),
      JSON.stringify({ data: { count: 5 }, final: 'There are 5 users.' }),
    ]);

    const service = buildService(provider, registry);
    const response = await service.prompt({ prompt: 'how many users are there?' } as any, {
      currentUser: { id: 'admin-1', roles: [RoleEnum.ADMIN] },
    });

    expect(response.text).toBe('There are 5 users.');
    expect(response.data).toEqual({ count: 5 });
    expect(response.actions).toHaveLength(1);
    expect(response.actions?.[0]).toMatchObject({ name: 'count_users', success: true });
    expect(response.iterations).toBe(2);
    expect(executedWith).toEqual({ args: { scope: 'all' }, user: 'admin-1' });
    expect(response.usage?.totalTokens).toBe(4);
  });

  it('does not offer tools the user may not access (role gating)', async () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool('admin_only', [RoleEnum.ADMIN], async () => ({ data: 'secret', success: true })));

    // Model "hallucinates" a call to a tool the non-admin user cannot use.
    const provider = new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: {}, name: 'admin_only' }] }),
      JSON.stringify({ final: 'Sorry, I cannot do that.' }),
    ]);

    const service = buildService(provider, registry);
    const response = await service.prompt({ prompt: 'use the admin tool' } as any, {
      currentUser: { id: 'user-1', roles: [] },
    });

    // The tool was rejected (not in the user's available set) → action marked unsuccessful.
    expect(response.actions?.[0]).toMatchObject({ name: 'admin_only', success: false });
    expect(response.text).toBe('Sorry, I cannot do that.');
  });

  it('short-circuits the loop with `pendingQuestion` when ask_user_question is called', async () => {
    const { ASK_USER_QUESTION_SENTINEL } = await import('../../src/core/modules/ai/tools/ask-user-question.tool');
    const registry = new AiToolRegistry();
    registry.register(
      makeTool('ask_user_question', [RoleEnum.S_USER], async (args) => ({
        data: {
          [ASK_USER_QUESTION_SENTINEL as unknown as string]: true,
          options: args.options,
          question: args.question,
        },
        success: true,
      })),
    );

    const provider = new ScriptedProvider([
      JSON.stringify({
        tool_calls: [
          {
            arguments: {
              options: [
                { label: 'Active', value: 'active' },
                { label: 'Inactive', value: 'inactive' },
              ],
              question: 'Which user status do you mean?',
            },
            name: 'ask_user_question',
          },
        ],
      }),
    ]);

    const service = buildService(provider, registry);
    const response = await service.prompt({ prompt: 'find the users' } as any, {
      currentUser: { id: 'u-1', roles: [] },
    });

    expect(response.pendingQuestion).toBeDefined();
    expect(response.pendingQuestion?.question).toBe('Which user status do you mean?');
    expect(response.pendingQuestion?.options).toEqual([
      { label: 'Active', value: 'active' },
      { label: 'Inactive', value: 'inactive' },
    ]);
    expect(response.text).toBe('Which user status do you mean?');
    expect(response.iterations).toBe(1);
    expect(response.requiresConfirmation).toBeFalsy();
  });

  it('extracts the tool call even when the model appends trailing text after the JSON', async () => {
    // Reproduces the Claude CLI behaviour: a valid {"tool_calls":[…]} followed by a
    // self-hallucinated TOOL_RESULTS block in the same response.
    let executed = false;
    const registry = new AiToolRegistry();
    registry.register(
      makeTool('server_time', [RoleEnum.S_USER], async () => {
        executed = true;
        return { data: { now: 'X' }, success: true };
      }),
    );
    const provider = new ScriptedProvider([
      '{"tool_calls":[{"name":"server_time","arguments":{}}]}\n\nTOOL_RESULTS:\n[{"name":"server_time","result":{"now":"fake"}}]',
      JSON.stringify({ final: 'The server time is X.' }),
    ]);
    const service = buildService(provider, registry);
    const response = await service.prompt({ prompt: 'time?' } as any, {
      currentUser: { id: 'u1', roles: [RoleEnum.S_USER] },
    });
    expect(executed).toBe(true);
    expect(response.actions?.[0]).toMatchObject({ name: 'server_time', success: true });
    expect(response.text).toBe('The server time is X.');
  });

  it('feeds back only the normalized tool_calls as the assistant turn (no raw/hallucinated text)', async () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool('server_time', [RoleEnum.S_USER], async () => ({ data: { now: 'X' }, success: true })));
    const seen: { content: string; role: string }[][] = [];
    class Capturing implements ILlmProvider {
      readonly capabilities = { jsonResponse: false, nativeTools: false, systemPrompt: true };
      readonly name = 'fake';
      private call = 0;
      async chat(messages: any): Promise<LlmResponse> {
        seen.push(messages.map((m: any) => ({ content: m.content, role: m.role })));
        this.call++;
        return this.call === 1
          ? { text: '{"tool_calls":[{"name":"server_time","arguments":{}}]}\n\nTOOL_RESULTS:\n[HALLUCINATED-FAKE]' }
          : { text: JSON.stringify({ final: 'done' }) };
      }
    }
    const service = buildService(new Capturing(), registry);
    await service.prompt({ prompt: 'time' } as any, { currentUser: { id: 'u1', roles: [RoleEnum.S_USER] } });
    const assistantTurn = seen[1]?.find((m) => m.role === 'assistant' && m.content.includes('tool_calls'));
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.content).not.toContain('HALLUCINATED-FAKE');
  });

  it('nudges once for a final answer when the model returns an empty tool_calls wrapper', async () => {
    const registry = new AiToolRegistry();
    // Model first returns a bare `{"tool_calls":[]}` (no answer), then a proper final.
    const provider = new ScriptedProvider([
      JSON.stringify({ tool_calls: [] }),
      JSON.stringify({ final: 'Here is the real answer.' }),
    ]);
    const service = buildService(provider, registry);
    const response = await service.prompt({ prompt: 'hi' } as any, { currentUser: { id: 'u1', roles: [] } });
    expect(response.text).toBe('Here is the real answer.');
    expect(response.iterations).toBe(2);
  });

  it('never leaks a bare protocol wrapper as the final answer', async () => {
    const registry = new AiToolRegistry();
    // Model keeps returning the empty wrapper even after the nudge.
    const provider = new ScriptedProvider([JSON.stringify({ tool_calls: [] }), JSON.stringify({ tool_calls: [] })]);
    const service = buildService(provider, registry);
    const response = await service.prompt({ prompt: 'hi' } as any, { currentUser: { id: 'u1', roles: [] } });
    expect(response.text).not.toContain('tool_calls');
    expect(response.text).toContain('could not produce a final answer');
  });

  it('plan mode executes a fully-permitted multi-step plan', async () => {
    const executed: string[] = [];
    const registry = new AiToolRegistry();
    registry.register(
      makeTool('read_a', [RoleEnum.S_USER], async () => {
        executed.push('read_a');
        return { data: { a: 1 }, success: true };
      }),
    );
    registry.register(
      makeTool('read_b', [RoleEnum.S_USER], async () => {
        executed.push('read_b');
        return { data: { b: 2 }, success: true };
      }),
    );

    const provider = new ScriptedProvider([
      JSON.stringify({
        plan: [
          { arguments: {}, name: 'read_a' },
          { arguments: {}, name: 'read_b' },
        ],
        summary: 'read both',
      }),
      JSON.stringify({ final: 'Both read.' }),
    ]);
    const response = await buildService(provider, registry).prompt({ mode: 'plan', prompt: 'read a and b' } as any, {
      currentUser: { id: 'u1', roles: [] },
    });

    expect(executed).toEqual(['read_a', 'read_b']);
    expect(response.denied).toBeFalsy();
    expect(response.plan?.map((a) => a.name)).toEqual(['read_a', 'read_b']);
    expect(response.actions).toHaveLength(2);
    expect(response.text).toBe('Both read.');
  });

  it('plan mode executes NOTHING and returns a translated error if one step is not permitted (pre-flight)', async () => {
    const executed: string[] = [];
    const registry = new AiToolRegistry();
    registry.register(
      makeTool('read_a', [RoleEnum.S_USER], async () => {
        executed.push('read_a');
        return { data: { a: 1 }, success: true };
      }),
    );
    registry.register(
      makeTool('admin_only', [RoleEnum.ADMIN], async () => {
        executed.push('admin_only');
        return { success: true };
      }),
    );

    const provider = new ScriptedProvider([
      JSON.stringify({
        plan: [
          { arguments: {}, name: 'read_a' },
          { arguments: {}, name: 'admin_only' },
        ],
        summary: 'x',
      }),
    ]);
    const response = await buildService(provider, registry).prompt(
      { language: 'de', mode: 'plan', prompt: 'do both' } as any,
      { currentUser: { id: 'u1', roles: [] }, language: 'de' },
    );

    // All-or-nothing: not a single step ran.
    expect(executed).toEqual([]);
    expect(response.denied).toBe(true);
    expect(response.deniedActions?.map((a) => a.name)).toContain('admin_only');
    // German message (translation respected).
    expect(response.text.toLowerCase()).toContain('nicht');
  });

  it('plan mode honors a tool authorize() data-level denial (pre-flight)', async () => {
    const executed: string[] = [];
    const registry = new AiToolRegistry();
    registry.register({
      authorize: async () => ({ allowed: false, reason: 'not the owner' }),
      description: 'edit a record',
      execute: async () => {
        executed.push('edit_record');
        return { success: true };
      },
      name: 'edit_record',
      parameters: { properties: {}, type: 'object' },
      roles: [RoleEnum.S_USER],
    });

    const provider = new ScriptedProvider([
      JSON.stringify({ plan: [{ arguments: { id: 'x' }, name: 'edit_record' }], summary: 'edit' }),
    ]);
    const response = await buildService(provider, registry).prompt({ mode: 'plan', prompt: 'edit x' } as any, {
      currentUser: { id: 'u1', roles: [RoleEnum.S_USER] },
    });

    expect(executed).toEqual([]);
    expect(response.denied).toBe(true);
    expect(response.deniedActions?.[0]).toMatchObject({ name: 'edit_record' });
  });

  it('treats plain text (no JSON protocol) as the final answer', async () => {
    const registry = new AiToolRegistry();
    const provider = new ScriptedProvider(['Just a plain answer.']);
    const service = buildService(provider, registry);
    const response = await service.prompt({ prompt: 'hello' } as any, { currentUser: { id: 'user-1', roles: [] } });
    expect(response.text).toBe('Just a plain answer.');
    expect(response.actions).toHaveLength(0);
  });

  it('includes client metadata (url, console logs) in the prompt sent to the LLM', async () => {
    const captured: string[] = [];
    const provider: ILlmProvider = {
      capabilities: { jsonResponse: false, nativeTools: false, systemPrompt: true },
      name: 'fake',
      async chat(messages) {
        captured.push(messages.map((m) => m.content).join(' || '));
        return { text: JSON.stringify({ final: 'ok' }), usage: {} };
      },
    };
    await buildService(provider, new AiToolRegistry()).prompt(
      {
        metadata: { consoleLogs: ['ReferenceError at line 7'], url: '/orders/42' },
        prompt: 'why does this page fail?',
      } as any,
      { currentUser: { id: 'u1', roles: [] } },
    );
    const all = captured.join(' ');
    expect(all).toContain('/orders/42');
    expect(all).toContain('ReferenceError at line 7');
  });

  it('streams action, token and final events; concatenated tokens equal the answer', async () => {
    let executed = false;
    const registry = new AiToolRegistry();
    registry.register(
      makeTool('count_users', [RoleEnum.ADMIN], async () => {
        executed = true;
        return { data: { count: 7 }, success: true };
      }),
    );
    const provider = new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: {}, name: 'count_users' }] }),
      JSON.stringify({ final: 'There are 7 users in total.' }),
    ]);
    const service = buildService(provider, registry);

    const events: any[] = [];
    for await (const ev of service.promptStream({ prompt: 'how many users?' } as any, {
      currentUser: { id: 'admin-1', roles: [RoleEnum.ADMIN] },
    })) {
      events.push(ev);
    }

    expect(executed).toBe(true);
    const actionEvents = events.filter((e) => e.type === 'action');
    const tokenEvents = events.filter((e) => e.type === 'token');
    const finalEvents = events.filter((e) => e.type === 'final');

    expect(actionEvents).toHaveLength(1);
    expect(actionEvents[0].action).toMatchObject({ name: 'count_users', success: true });
    expect(tokenEvents.length).toBeGreaterThan(1);
    expect(tokenEvents.map((e) => e.token).join('')).toBe('There are 7 users in total.');
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0].response.text).toBe('There are 7 users in total.');
  });

  it('exposes only role-permitted tools via MCP and rejects forbidden calls', async () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool('public_info', [RoleEnum.S_EVERYONE], async () => ({ data: 'pub', success: true })));
    registry.register(makeTool('admin_op', [RoleEnum.ADMIN], async () => ({ data: 'secret', success: true })));
    const mcp = new CoreAiMcpService(registry);

    const adminTools = mcp
      .mcpListTools({ id: 'a', roles: [RoleEnum.ADMIN] })
      .map((t) => t.name)
      .sort();
    const userTools = mcp.mcpListTools({ id: 'u', roles: [] }).map((t) => t.name);
    expect(adminTools).toEqual(['admin_op', 'public_info']);
    expect(userTools).toEqual(['public_info']);
    // The MCP inputSchema is the tool's JSON schema.
    expect(mcp.mcpListTools({ id: 'u', roles: [] })[0].inputSchema).toEqual({ properties: {}, type: 'object' });

    const ok = await mcp.mcpCallTool({ id: 'a', roles: [RoleEnum.ADMIN] }, 'admin_op', {});
    expect(ok.isError).toBeFalsy();
    const denied = await mcp.mcpCallTool({ id: 'u', roles: [] }, 'admin_op', {});
    expect(denied.isError).toBe(true);
  });

  it('halts a destructive tool until the user confirms', async () => {
    let executed = 0;
    const registry = new AiToolRegistry();
    const deleteTool: IAiTool = {
      description: 'Delete a user',
      destructive: true,
      execute: async () => {
        executed++;
        return { success: true };
      },
      name: 'delete_user',
      parameters: { properties: { id: { type: 'string' } }, type: 'object' },
      roles: [RoleEnum.ADMIN],
    };
    registry.register(deleteTool);

    // Without confirmation: the destructive call must be blocked.
    const providerA = new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: { id: 'x' }, name: 'delete_user' }] }),
      JSON.stringify({ final: 'done' }),
    ]);
    const responseA = await buildService(providerA, registry).prompt({ prompt: 'delete user x' } as any, {
      currentUser: { id: 'admin-1', roles: [RoleEnum.ADMIN] },
    });
    expect(executed).toBe(0);
    expect(responseA.requiresConfirmation).toBe(true);
    expect(responseA.pendingActions?.[0]).toMatchObject({ name: 'delete_user' });

    // With confirmation: the destructive call executes.
    const providerB = new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: { id: 'x' }, name: 'delete_user' }] }),
      JSON.stringify({ final: 'deleted' }),
    ]);
    const responseB = await buildService(providerB, registry).prompt(
      { confirm: true, prompt: 'delete user x' } as any,
      { currentUser: { id: 'admin-1', roles: [RoleEnum.ADMIN] } },
    );
    expect(executed).toBe(1);
    expect(responseB.requiresConfirmation).toBeFalsy();
    expect(responseB.text).toBe('deleted');
  });

  // --- Confirmation policy for mutating actions (admin default / client override / enforced) ---

  function mutatingRegistry(executed: string[]) {
    const registry = new AiToolRegistry();
    registry.register({
      description: 'create a record',
      execute: async () => {
        executed.push('create_x');
        return { success: true };
      },
      mutating: true,
      name: 'create_x',
      parameters: { properties: {}, type: 'object' },
      roles: [RoleEnum.S_USER],
    });
    return registry;
  }

  function mutatingProvider() {
    return new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: {}, name: 'create_x' }] }),
      JSON.stringify({ final: 'created' }),
    ]);
  }

  it('mutating action runs without confirmation when the admin default is off', async () => {
    new ConfigService({ ai: { confirmation: { mutating: { default: false } }, maxIterations: 5 } } as any);
    const executed: string[] = [];
    const response = await buildService(mutatingProvider(), mutatingRegistry(executed)).prompt(
      { prompt: 'create x' } as any,
      { currentUser: { id: 'u1', roles: [RoleEnum.S_USER] } },
    );
    expect(executed).toEqual(['create_x']);
    expect(response.requiresConfirmation).toBeFalsy();
  });

  it('mutating action requires confirmation when the admin default is on', async () => {
    new ConfigService({ ai: { confirmation: { mutating: { default: true } }, maxIterations: 5 } } as any);
    const executed: string[] = [];
    const response = await buildService(mutatingProvider(), mutatingRegistry(executed)).prompt(
      { prompt: 'create x' } as any,
      { currentUser: { id: 'u1', roles: [RoleEnum.S_USER] } },
    );
    expect(executed).toEqual([]);
    expect(response.requiresConfirmation).toBe(true);
  });

  it('client can override the admin default to skip confirmation (when not enforced)', async () => {
    new ConfigService({ ai: { confirmation: { mutating: { default: true } }, maxIterations: 5 } } as any);
    const executed: string[] = [];
    const response = await buildService(mutatingProvider(), mutatingRegistry(executed)).prompt(
      { prompt: 'create x', requireConfirmation: false } as any,
      { currentUser: { id: 'u1', roles: [RoleEnum.S_USER] } },
    );
    expect(executed).toEqual(['create_x']);
    expect(response.requiresConfirmation).toBeFalsy();
  });

  it('enforced policy cannot be overridden by the client', async () => {
    new ConfigService({
      ai: { confirmation: { mutating: { default: true, enforced: true } }, maxIterations: 5 },
    } as any);
    const executed: string[] = [];
    const response = await buildService(mutatingProvider(), mutatingRegistry(executed)).prompt(
      { prompt: 'create x', requireConfirmation: false } as any,
      { currentUser: { id: 'u1', roles: [RoleEnum.S_USER] } },
    );
    expect(executed).toEqual([]);
    expect(response.requiresConfirmation).toBe(true);
  });

  it('persistent grant from a prior remembered decision skips the confirmation gate', async () => {
    new ConfigService({ ai: { confirmation: { mutating: { default: true } }, maxIterations: 5 } } as any);
    const executed: string[] = [];
    const grantsLookedUp: { scope: string; tool: string }[] = [];
    const fakeGrantService = {
      findActiveGrant: async (tool: string, scopes: any) => {
        grantsLookedUp.push({ scope: 'user', tool });
        return scopes.userId === 'u-with-grant' ? 'user' : undefined;
      },
      grant: async () => undefined,
    } as any;
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => mutatingProvider());
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://fake', id: 'c1', model: 'm', name: 'F', providerType: 'fake' }),
    } as any;
    const service = new CoreAiService(
      connectionService,
      factory,
      mutatingRegistry(executed),
      new CoreAiPromptBuilderService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeGrantService,
    );

    // User WITHOUT a grant: must still be gated.
    const noGrant = await service.prompt({ prompt: 'create x' } as any, {
      currentUser: { id: 'u1', roles: [RoleEnum.S_USER] },
    });
    expect(noGrant.requiresConfirmation).toBe(true);
    expect(executed).toEqual([]);

    // User WITH a grant: the gate is skipped and the action runs.
    factory.registerBuilder('fake', () => mutatingProvider());
    const withGrant = await service.prompt({ prompt: 'create x' } as any, {
      currentUser: { id: 'u-with-grant', roles: [RoleEnum.S_USER] },
    });
    expect(withGrant.requiresConfirmation).toBeFalsy();
    expect(executed).toEqual(['create_x']);
  });

  it('scoped tool-policy `deny` aborts the call with a structured error', async () => {
    new ConfigService({ ai: { confirmation: { mutating: { default: false } }, maxIterations: 5 } } as any);
    const executed: string[] = [];
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => mutatingProvider());
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://fake', id: 'c1', model: 'm', name: 'F', providerType: 'fake' }),
    } as any;
    const fakePolicy = {
      evaluate: async (tool: string) =>
        tool === 'create_x' ? { decision: 'deny' as const, reason: 'forbidden by tenant policy' } : undefined,
    } as any;
    const service = new CoreAiService(
      connectionService,
      factory,
      mutatingRegistry(executed),
      new CoreAiPromptBuilderService(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, fakePolicy,
    );
    const response = await service.prompt({ prompt: 'create x' } as any, {
      currentUser: { id: 'u1', roles: [RoleEnum.S_USER] },
    });
    expect(executed).toEqual([]); // tool never ran
    expect(response.actions?.[0]).toMatchObject({ name: 'create_x', success: false });
    expect(JSON.stringify(response.actions?.[0]?.result)).toContain('forbidden by tenant policy');
    expect(response.text).toMatch(/not permitted by policy/);
  });

  it('scoped tool-policy `ask` forces the confirmation gate even on a non-mutating tool', async () => {
    new ConfigService({ ai: { confirmation: { mutating: { default: false } }, maxIterations: 5 } } as any);
    const executed: string[] = [];
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => mutatingProvider());
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://fake', id: 'c1', model: 'm', name: 'F', providerType: 'fake' }),
    } as any;
    const fakePolicy = {
      evaluate: async (tool: string) => (tool === 'create_x' ? { decision: 'ask' as const } : undefined),
    } as any;
    const service = new CoreAiService(
      connectionService,
      factory,
      mutatingRegistry(executed),
      new CoreAiPromptBuilderService(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, fakePolicy,
    );
    const response = await service.prompt({ prompt: 'create x' } as any, {
      currentUser: { id: 'u1', roles: [RoleEnum.S_USER] },
    });
    expect(executed).toEqual([]); // not yet run — gate is on
    expect(response.requiresConfirmation).toBe(true);
    expect(response.pendingActions?.[0]).toMatchObject({ name: 'create_x' });
  });

  it('MCP-Client: external MCP-server tools are registered with namespaced names and dispatch back to callTool', async () => {
    const { CoreAiMcpClientService } = await import(
      '../../src/core/modules/ai/services/core-ai-mcp-client.service'
    );
    new ConfigService({ ai: {} } as any);
    // Fake MCP-like client: ducks-typed listTools + callTool.
    let calledWith: any = null;
    const fakeMcp = {
      listTools: async () => ({
        tools: [
          {
            description: 'Search the local filesystem',
            inputSchema: { properties: { query: { type: 'string' } }, required: ['query'], type: 'object' },
            name: 'fs_search',
          },
        ],
      }),
      callTool: async (req: any) => {
        calledWith = req;
        return { content: [{ text: JSON.stringify({ hits: 3 }), type: 'text' }] };
      },
    };
    const registry = new AiToolRegistry();
    const svc = new CoreAiMcpClientService(registry);
    await svc.registerExternalClient({ client: fakeMcp as any, name: 'localfs' });

    const tools = registry.all();
    expect(tools.map((t) => t.name)).toContain('localfs_fs_search');
    const tool = tools.find((t) => t.name === 'localfs_fs_search')!;
    expect(tool.description).toBe('Search the local filesystem');
    expect(tool.parameters).toEqual(expect.objectContaining({ properties: { query: { type: 'string' } } }));

    // Execute through our wrapper — it should call back to the MCP client.
    const result: any = await tool.execute({ query: 'foo' }, { currentUser: { id: 'u1', roles: ['admin'] } } as any);
    expect(calledWith).toEqual({ arguments: { query: 'foo' }, name: 'fs_search' });
    expect(result?.success).toBe(true);
  });

  it('multi-modal: input.attachments are forwarded to the provider on the user message', async () => {
    new ConfigService({ ai: {} } as any);
    const registry = new AiToolRegistry();
    let capturedMessages: any[] | undefined;
    const captureProvider: ILlmProvider = {
      capabilities: { jsonResponse: false, nativeTools: false, systemPrompt: true },
      chat: async (msgs: any[]) => {
        capturedMessages = msgs;
        return { text: JSON.stringify({ final: 'Got the image.' }) };
      },
      name: 'capture',
    };
    const factory = new LlmProviderFactory();
    factory.registerBuilder('capture', () => captureProvider);
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://x', id: 'c1', model: 'm', name: 'C', providerType: 'capture' }),
    } as any;
    const service = new CoreAiService(connectionService, factory, registry, new CoreAiPromptBuilderService());
    await service.prompt(
      {
        attachments: [{ mimeType: 'image/png', name: 'screenshot.png', url: 'data:image/png;base64,AAA' }],
        prompt: 'What is in this screenshot?',
      } as any,
      { currentUser: { id: 'u1', roles: [RoleEnum.S_USER] } },
    );
    expect(capturedMessages).toBeDefined();
    const userMsg = capturedMessages?.find((m) => m.role === 'user' && /screenshot/.test(m.content || ''));
    expect(userMsg).toBeDefined();
    expect(userMsg?.attachments).toEqual([
      expect.objectContaining({ mimeType: 'image/png', name: 'screenshot.png' }),
    ]);
  });

  it('named mode restricts tools to its allowedTools list', async () => {
    const { CoreAiModeService } = await import('../../src/core/modules/ai/services/core-ai-mode.service');
    new ConfigService({ ai: {} } as any);
    const registry = new AiToolRegistry();
    registry.register(makeTool('read_only_tool', [RoleEnum.S_USER], async () => ({ data: 'ok', success: true })));
    registry.register(makeTool('hidden_tool', [RoleEnum.S_USER], async () => ({ data: 'nope', success: true })));
    const fakeModeService = {
      getByName: async (name: string) =>
        name === 'support'
          ? { name: 'support', allowedTools: ['read_only_tool'], enabled: true }
          : null,
    } as unknown as InstanceType<typeof CoreAiModeService>;
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: {}, name: 'hidden_tool' }] }),
      JSON.stringify({ final: 'Sorry, that tool is not available.' }),
    ]));
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://fake', id: 'c1', model: 'm', name: 'F', providerType: 'fake' }),
    } as any;
    const service = new CoreAiService(
      connectionService,
      factory,
      registry,
      new CoreAiPromptBuilderService(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, fakeModeService,
    );
    const response = await service.prompt({ prompt: 'do hidden thing', agentMode: 'support' } as any, {
      currentUser: { id: 'u1', roles: [RoleEnum.S_USER] },
    });
    // hidden_tool was filtered out of the user's available set by the mode;
    // the model's attempt to call it is rejected as "not available".
    expect(response.actions?.[0]).toMatchObject({ name: 'hidden_tool', success: false });
    expect(response.actions?.[0]?.result).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'TOOL_NOT_AVAILABLE' }),
    }));
  });

  it('AI hook can block a tool call via preToolUse', async () => {
    const { AiHookRegistry } = await import('../../src/core/modules/ai/hooks/ai-hook.registry');
    new ConfigService({ ai: { maxIterations: 5 } } as any);
    const executed: string[] = [];
    const registry = mutatingRegistry(executed);
    const hooks = new AiHookRegistry();
    hooks.register({
      name: 'block-create-x',
      preToolUse: () => ({ block: true, reason: 'denied by policy' }),
    });
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => mutatingProvider());
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://fake', id: 'c1', model: 'm', name: 'F', providerType: 'fake' }),
    } as any;
    const service = new CoreAiService(
      connectionService,
      factory,
      registry,
      new CoreAiPromptBuilderService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      hooks,
    );
    const response = await service.prompt({ confirm: true, prompt: 'create x' } as any, {
      currentUser: { id: 'u1', roles: [RoleEnum.S_USER] },
    });
    expect(executed).toEqual([]); // tool was blocked by the hook
    expect(response.actions?.[0]).toMatchObject({ name: 'create_x', success: false });
    expect(JSON.stringify(response.actions?.[0]?.result)).toContain('denied by policy');
  });

  it('AI hook postToolUse is notified after execution', async () => {
    const { AiHookRegistry } = await import('../../src/core/modules/ai/hooks/ai-hook.registry');
    ConfigService.setConfig({ ai: { confirmation: { mutating: { default: false } }, maxIterations: 5 } } as any, { reInit: true });
    const seen: { name: string; success: boolean }[] = [];
    const hooks = new AiHookRegistry();
    hooks.register({
      name: 'observe',
      postToolUse: (call, _tool, result) => {
        seen.push({ name: call.name, success: result.success });
      },
    });
    const executed: string[] = [];
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => mutatingProvider());
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://fake', id: 'c1', model: 'm', name: 'F', providerType: 'fake' }),
    } as any;
    const service = new CoreAiService(
      connectionService,
      factory,
      mutatingRegistry(executed),
      new CoreAiPromptBuilderService(),
      undefined, undefined, undefined, undefined, undefined, undefined, hooks,
    );
    await service.prompt({ prompt: 'create x' } as any, {
      currentUser: { id: 'u1', roles: [RoleEnum.S_USER] },
    });
    expect(seen).toEqual([{ name: 'create_x', success: true }]);
  });

  it('persists a grant when the user confirms with rememberDecision="user"', async () => {
    new ConfigService({ ai: { confirmation: { mutating: { default: true } }, maxIterations: 5 } } as any);
    const executed: string[] = [];
    const persisted: { refId: string; scope: string; tool: string }[] = [];
    const fakeGrantService = {
      findActiveGrant: async () => undefined,
      grant: async (tool: string, scope: string, refId: string) => {
        persisted.push({ refId, scope, tool });
      },
    } as any;
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => mutatingProvider());
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://fake', id: 'c1', model: 'm', name: 'F', providerType: 'fake' }),
    } as any;
    const service = new CoreAiService(
      connectionService,
      factory,
      mutatingRegistry(executed),
      new CoreAiPromptBuilderService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeGrantService,
    );

    await service.prompt({ confirm: true, prompt: 'create x', rememberDecision: 'user' } as any, {
      currentUser: { id: 'u1', roles: [RoleEnum.S_USER] },
    });
    expect(executed).toEqual(['create_x']);
    expect(persisted).toEqual([{ refId: 'u1', scope: 'user', tool: 'create_x' }]);
  });
});

/**
 * MCP HTTP session lifecycle tests (`CoreAiMcpController`).
 *
 * These exercise the controller's request-routing logic — `resolveUser` chain,
 * MCP-style 401 response, "unknown session" 404 path, and the `evictIfNeeded`
 * cap. They use a hand-rolled fake `Request`/`Response` rather than supertest
 * because the controller's heavy lifting (transport.handleRequest) is delegated
 * to the MCP SDK, which is exercised separately by the in-memory protocol test.
 */
describe('CoreAiMcpController (HTTP session lifecycle)', () => {
  beforeAll(() => {
    new ConfigService({ ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-secret-32-characters!!' } } } as any);
  });

  function makeReq(opts: { authorization?: string; body?: any; method?: string; sessionId?: string; user?: any } = {}) {
    return {
      body: opts.body ?? {},
      get: (name: string) => (name.toLowerCase() === 'host' ? 'api.example.com' : undefined),
      headers: {
        ...(opts.authorization && { authorization: opts.authorization }),
        ...(opts.sessionId && { 'mcp-session-id': opts.sessionId }),
      },
      method: opts.method ?? 'POST',
      protocol: 'https',
      ...(opts.user && { user: opts.user }),
    } as any;
  }

  function makeRes() {
    const captured: { body?: any; headers: Record<string, string>; status?: number } = { headers: {} };
    const res: any = {
      json: (b: any) => {
        captured.body = b;
        return res;
      },
      set: (h: Record<string, string>) => {
        Object.assign(captured.headers, h);
        return res;
      },
      status: (s: number) => {
        captured.status = s;
        return res;
      },
    };
    return { captured, res };
  }

  it('returns 401 with WWW-Authenticate header when no authentication is presented (handlePost)', async () => {
    const controller = new CoreAiMcpController({} as any, new CoreAiMcpOAuthService({} as any));
    const { captured, res } = makeRes();
    await controller.handlePost(makeReq(), res);
    expect(captured.status).toBe(401);
    expect(captured.headers['WWW-Authenticate']).toMatch(/Bearer resource_metadata="/);
    expect(captured.headers['WWW-Authenticate']).toContain('https://api.example.com/ai/mcp');
    expect(captured.body).toMatchObject({ error: expect.stringMatching(/Bearer token/i) });
  });

  it('returns 401 from handleGet when no authentication is presented', async () => {
    const controller = new CoreAiMcpController({} as any, new CoreAiMcpOAuthService({} as any));
    const { captured, res } = makeRes();
    await controller.handleGet(makeReq({ method: 'GET' }), res);
    expect(captured.status).toBe(401);
  });

  it('returns 401 from handleDelete when no authentication is presented', async () => {
    const controller = new CoreAiMcpController({} as any, new CoreAiMcpOAuthService({} as any));
    const { captured, res } = makeRes();
    await controller.handleDelete(makeReq({ method: 'DELETE' }), res);
    expect(captured.status).toBe(401);
  });

  it('handleGet returns 404 when authenticated but the session id is unknown', async () => {
    const controller = new CoreAiMcpController({} as any, new CoreAiMcpOAuthService({} as any));
    const { captured, res } = makeRes();
    await controller.handleGet(
      makeReq({ method: 'GET', sessionId: 'no-such-session', user: { id: 'u1', roles: [] } }),
      res,
    );
    expect(captured.status).toBe(404);
    expect(captured.body).toMatchObject({ error: expect.stringMatching(/Unknown or expired MCP session/i) });
  });

  it('handleDelete returns 404 when the session id is unknown', async () => {
    const controller = new CoreAiMcpController({} as any, new CoreAiMcpOAuthService({} as any));
    const { captured, res } = makeRes();
    await controller.handleDelete(
      makeReq({ method: 'DELETE', sessionId: 'ghost-session', user: { id: 'u1', roles: [] } }),
      res,
    );
    expect(captured.status).toBe(404);
  });

  it('resolveUser prefers req.user (the BetterAuth middleware path)', async () => {
    const controller = new CoreAiMcpController({} as any, new CoreAiMcpOAuthService({} as any));
    const req = makeReq({ user: { id: 'u-from-middleware', roles: ['admin'] } });
    const resolved = await (controller as any).resolveUser(req);
    expect(resolved).toMatchObject({ id: 'u-from-middleware' });
  });

  it('resolveUser falls back to verifying the OAuth Bearer token when no req.user (SEC-005 cross-check)', async () => {
    // Stub `loadUser` to avoid touching MongoDB.
    const oauth = new CoreAiMcpOAuthService({} as any);
    (oauth as any).loadUser = async (uid: string) => ({ id: uid, roles: [] });
    const controller = new CoreAiMcpController({} as any, oauth);

    const accessToken = oauth.signAccessToken('u-oauth', 'cid-x', 3600);
    const resolved = await (controller as any).resolveUser(makeReq({ authorization: `Bearer ${accessToken}` }));
    expect(resolved).toMatchObject({ id: 'u-oauth' });
  });

  it('resolveUser returns null for a tampered OAuth Bearer token', async () => {
    const oauth = new CoreAiMcpOAuthService({} as any);
    (oauth as any).loadUser = async () => ({ id: 'should-not-be-reached', roles: [] });
    const controller = new CoreAiMcpController({} as any, oauth);
    const validToken = oauth.signAccessToken('u-victim', 'cid-x', 3600);
    const tampered = validToken.replace(/.$/, 'x'); // mutate the signature segment
    const resolved = await (controller as any).resolveUser(makeReq({ authorization: `Bearer ${tampered}` }));
    expect(resolved).toBeNull();
  });

  it('evictIfNeeded drops the oldest entry when the cap is reached', () => {
    const oauth = new CoreAiMcpOAuthService({} as any);
    const controller: any = new CoreAiMcpController({} as any, oauth);
    // Force a small cap to keep the test fast.
    controller.maxSessions = 3;
    controller.transports.set('a', { lastUsed: 100, transport: { close: () => {} } });
    controller.transports.set('b', { lastUsed: 200, transport: { close: () => {} } });
    controller.transports.set('c', { lastUsed: 300, transport: { close: () => {} } });
    controller.evictIfNeeded();
    // The oldest entry ("a") is dropped to free a slot.
    expect(controller.transports.has('a')).toBe(false);
    expect(controller.transports.has('b')).toBe(true);
    expect(controller.transports.has('c')).toBe(true);
  });

  it('evictIfNeeded is a no-op when below the cap', () => {
    const oauth = new CoreAiMcpOAuthService({} as any);
    const controller: any = new CoreAiMcpController({} as any, oauth);
    controller.maxSessions = 5;
    controller.transports.set('only', { lastUsed: 100, transport: { close: () => {} } });
    controller.evictIfNeeded();
    expect(controller.transports.has('only')).toBe(true);
  });

  it('mcpUnavailable returns 503 with an actionable install hint (BUG-2 regression)', () => {
    const oauth = new CoreAiMcpOAuthService({} as any);
    const controller: any = new CoreAiMcpController({} as any, oauth);
    const { captured, res } = makeRes();
    controller.mcpUnavailable(res, new Error("Cannot find module '@modelcontextprotocol/sdk/server/streamableHttp.js'"));
    expect(captured.status).toBe(503);
    expect(captured.body).toMatchObject({
      statusCode: 503,
      error: expect.stringMatching(/@modelcontextprotocol\/sdk/),
    });
    // The actionable hint must mention the install command — that's the whole
    // point of the friendlier response (a raw 500 wouldn't help the integrator).
    expect(captured.body.error).toMatch(/pnpm add|npm i/);
  });
});

/**
 * `loadRecentMessages` defensive-input tests (BUG-1 regression).
 *
 * Clients sometimes pass the literal strings `"null"` or `"undefined"` instead
 * of leaving the field undefined — Mongoose would then BSON-cast-fail
 * inside the orchestrator's prompt pipeline and bubble a 500 to the user.
 * The service now short-circuits before the DB call.
 */
describe('CoreAiConversationService.loadRecentMessages (defensive input)', () => {
  async function makeService() {
    const { CoreAiConversationService } = await import(
      '../../src/core/modules/ai/services/core-ai-conversation.service'
    );
    // We do not exercise the DB path here; the early-return branches must not
    // touch the Mongoose model at all.
    const exec = vi.fn();
    const lean = vi.fn(() => ({ exec }));
    const findById = vi.fn(() => ({ lean }));
    const model: any = { findById };
    // 3rd arg (Mongoose connection) added to the service constructor in 11.31.2; the early-return
    // branches under test never touch it, so a stub is sufficient.
    const svc = new CoreAiConversationService(model, CoreAiConversationService as any, {} as any);
    return { svc, findById };
  }

  it('returns [] without touching the DB for the literal string "null"', async () => {
    const { svc, findById } = await makeService();
    const result = await svc.loadRecentMessages('null', { id: 'u1' });
    expect(result).toEqual([]);
    expect(findById).not.toHaveBeenCalled();
  });

  it('returns [] without touching the DB for the literal string "undefined"', async () => {
    const { svc, findById } = await makeService();
    const result = await svc.loadRecentMessages('undefined', { id: 'u1' });
    expect(result).toEqual([]);
    expect(findById).not.toHaveBeenCalled();
  });

  it('returns [] for an empty string id', async () => {
    const { svc, findById } = await makeService();
    const result = await svc.loadRecentMessages('', { id: 'u1' });
    expect(result).toEqual([]);
    expect(findById).not.toHaveBeenCalled();
  });

  it('returns [] for any non-24-hex string (does not throw BSON cast error)', async () => {
    const { svc, findById } = await makeService();
    const result = await svc.loadRecentMessages('not-an-objectid', { id: 'u1' });
    expect(result).toEqual([]);
    expect(findById).not.toHaveBeenCalled();
  });

  it('returns [] for a non-string (defensive against bad client input)', async () => {
    const { svc, findById } = await makeService();
    const result = await svc.loadRecentMessages(42 as unknown as string, { id: 'u1' });
    expect(result).toEqual([]);
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('CoreAiMcpService (MCP protocol via in-memory transport)', () => {
  it('handshakes, lists role-filtered tools and executes a permitted tool', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const registry = new AiToolRegistry();
    registry.register(
      makeTool('public_info', [RoleEnum.S_EVERYONE], async () => ({ data: { ok: true }, success: true })),
    );
    registry.register(makeTool('admin_op', [RoleEnum.ADMIN], async () => ({ success: true })));

    const mcp = new CoreAiMcpService(registry);
    const server = await mcp.createServer({ id: 'u1', roles: [] }); // non-admin user

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport); // initialize handshake

    const tools = await client.listTools();
    expect(tools.tools.map((t: any) => t.name)).toEqual(['public_info']); // admin_op filtered by role

    const result: any = await client.callTool({ arguments: {}, name: 'public_info' });
    expect(JSON.stringify(result.content)).toContain('ok');

    await client.close();
  });
});

describe('CoreAiMcpOAuthService (security primitives)', () => {
  beforeAll(() => {
    new ConfigService({ ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-secret-32-characters!!' } } } as any);
  });

  function svc() {
    // The security primitives do not use the Mongoose connection.
    return new CoreAiMcpOAuthService({} as any);
  }

  it('signs and verifies an access token (roundtrip)', () => {
    const s = svc();
    const token = s.signAccessToken('user-1', 'client-1', 3600);
    const payload = s.verifyAccessToken(token);
    expect(payload).toMatchObject({ cid: 'client-1', sub: 'user-1', type: 'mcp_access' });
  });

  it('assertProductionSafe throws only when oauth is enabled in production without a secret', () => {
    const savedNsc = process.env.NSC__AI__ENCRYPTION_SECRET;
    const savedSec = process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.NSC__AI__ENCRYPTION_SECRET;
    delete process.env.SECRETS_ENCRYPTION_KEY;
    try {
      const s = svc();
      // oauth enabled + production + no secret → throws (reInit replaces config)
      ConfigService.setConfig({ ai: { mcp: { oauth: true } }, env: 'production' } as any, { reInit: true });
      expect(() => s.assertProductionSafe()).toThrow(/OAuth signing secret is required/i);
      // oauth NOT enabled + production + no secret → ok (secret irrelevant)
      ConfigService.setConfig({ ai: { mcp: {} }, env: 'production' } as any, { reInit: true });
      expect(() => s.assertProductionSafe()).not.toThrow();
      // oauth enabled + production + secret set → ok
      ConfigService.setConfig(
        {
          ai: { encryptionSecret: 'a-strong-secret-1234567890-abcdef', mcp: { oauth: true } },
          env: 'production',
        } as any,
        { reInit: true },
      );
      expect(() => s.assertProductionSafe()).not.toThrow();
      // oauth enabled + non-production + no secret → ok
      ConfigService.setConfig({ ai: { mcp: { oauth: true } }, env: 'local' } as any, { reInit: true });
      expect(() => s.assertProductionSafe()).not.toThrow();
    } finally {
      if (savedNsc !== undefined) {
        process.env.NSC__AI__ENCRYPTION_SECRET = savedNsc;
      }
      if (savedSec !== undefined) {
        process.env.SECRETS_ENCRYPTION_KEY = savedSec;
      }
      ConfigService.setConfig(
        { ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-secret-32-characters!!' } } } as any,
        { reInit: true },
      );
    }
  });

  it('rejects a tampered token', () => {
    const s = svc();
    const token = s.signAccessToken('user-1', 'client-1');
    expect(s.verifyAccessToken(token + 'x')).toBeNull();
    const [p] = token.split('.');
    expect(s.verifyAccessToken(`${p}.deadbeef`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const s = svc();
    const token = s.signAccessToken('user-1', 'client-1', -1);
    expect(s.verifyAccessToken(token)).toBeNull();
  });

  it('verifies PKCE S256 and rejects a wrong verifier / plain method', () => {
    const s = svc();
    const verifier = 'a-random-code-verifier-string-1234567890';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(s.verifyPkce(verifier, challenge)).toBe(true);
    expect(s.verifyPkce('wrong-verifier', challenge)).toBe(false);
    expect(s.verifyPkce(verifier, challenge, 'plain')).toBe(false);
  });
});

describe('CoreAiBudgetService (limits + usage logic)', () => {
  // Test subclass: stubs the native usage read and the override lookup.
  function makeBudget(overrideDoc: any, usage: { resetAt: Date | null; usedPrompts: number; usedTokens: number }) {
    const model = { findOne: () => ({ lean: () => ({ exec: async () => overrideDoc }) }) };
    const svc = new CoreAiBudgetService({} as any, model as any, CoreAiBudgetService as any);
    (svc as any).getUsage = async () => usage;
    return svc;
  }

  it('resolveLimit prefers the persisted override, else the config default', async () => {
    new ConfigService({ ai: { budget: { period: 'day', user: { maxTokens: 1000 } } } } as any);
    const fromDefault = await makeBudget(null, { resetAt: null, usedPrompts: 0, usedTokens: 0 }).resolveLimit(
      'user',
      'u1',
    );
    expect(fromDefault).toMatchObject({ maxTokens: 1000, period: 'day' });

    const withOverride = await makeBudget(
      { maxTokens: 50, period: 'month' },
      {
        resetAt: null,
        usedPrompts: 0,
        usedTokens: 0,
      },
    ).resolveLimit('user', 'u1');
    expect(withOverride).toMatchObject({ maxTokens: 50, period: 'month' });
  });

  it('assertWithinBudget throws 429 when the token limit is reached, passes when under', async () => {
    new ConfigService({ ai: { budget: { user: { maxTokens: 100 } } } } as any);
    await expect(
      makeBudget(null, { resetAt: null, usedPrompts: 0, usedTokens: 100 }).assertWithinBudget('u1', undefined, 'de'),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      makeBudget(null, { resetAt: null, usedPrompts: 0, usedTokens: 40 }).assertWithinBudget('u1', undefined, 'de'),
    ).resolves.toBeUndefined();
  });

  it('treats a 0 limit as unlimited (no throw)', async () => {
    new ConfigService({
      ai: { budget: { tenant: { maxPrompts: 0, maxTokens: 0 }, user: { maxPrompts: 0, maxTokens: 0 } } },
    } as any);
    await expect(
      makeBudget(null, { resetAt: null, usedPrompts: 999999, usedTokens: 999999 }).assertWithinBudget('u1'),
    ).resolves.toBeUndefined();
  });

  it('buildSummary reports prompt cost, used and remaining tokens + resetAt', async () => {
    new ConfigService({ ai: { budget: { user: { maxTokens: 1000 } } } } as any);
    const reset = new Date('2030-01-02T00:00:00Z');
    const summary = await makeBudget(null, { resetAt: reset, usedPrompts: 3, usedTokens: 300 }).buildSummary(
      'u1',
      undefined,
      20,
    );
    expect(summary).toMatchObject({ promptTokens: 20, remainingTokens: 700, resetAt: reset, usedTokens: 300 });
  });

  it('getUsageInfo includes the tenant scope when a tenant is given', async () => {
    new ConfigService({ ai: { budget: { tenant: { maxTokens: 5000 }, user: { maxTokens: 1000 } } } } as any);
    const info = await makeBudget(null, { resetAt: null, usedPrompts: 1, usedTokens: 100 }).getUsageInfo('u1', 't1');
    expect(info.user).toMatchObject({ maxTokens: 1000, remainingTokens: 900, scope: 'user', usedTokens: 100 });
    expect(info.tenant).toMatchObject({ maxTokens: 5000, scope: 'tenant', usedTokens: 100 });
  });
});

describe('CoreAiService + budget integration', () => {
  function serviceWithBudget(budgetService: any) {
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => new ScriptedProvider([JSON.stringify({ final: 'ok' })]));
    const connectionService = {
      resolve: async () => ({
        apiKey: '',
        baseUrl: 'http://fake',
        id: 'c1',
        model: 'fake',
        name: 'F',
        providerType: 'fake',
      }),
    } as any;
    return new CoreAiService(
      connectionService,
      factory,
      new AiToolRegistry(),
      new CoreAiPromptBuilderService(),
      undefined,
      undefined,
      budgetService,
    );
  }

  it('attaches the budget summary to the response', async () => {
    new ConfigService({ ai: { maxIterations: 5 } } as any);
    const budgetService = {
      assertWithinBudget: async () => undefined,
      buildSummary: async (_u: any, _t: any, promptTokens: number) => ({
        promptTokens,
        remainingTokens: 880,
        usedTokens: 120,
      }),
    };
    const response = await serviceWithBudget(budgetService).prompt({ prompt: 'hi' } as any, {
      currentUser: { id: 'u1', roles: [] },
    });
    expect(response.budget).toMatchObject({ remainingTokens: 880, usedTokens: 120 });
  });

  it('blocks the run when assertWithinBudget rejects', async () => {
    new ConfigService({ ai: { maxIterations: 5 } } as any);
    const budgetService = {
      assertWithinBudget: async () => {
        throw new Error('budget exceeded');
      },
      buildSummary: async () => ({}),
    };
    await expect(
      serviceWithBudget(budgetService).prompt({ prompt: 'hi' } as any, { currentUser: { id: 'u1', roles: [] } }),
    ).rejects.toThrow(/budget exceeded/);
  });
});

describe('CoreAiConnectionResolverService (resolution chain)', () => {
  type Conn = {
    enforced?: boolean;
    enforcedTenantIds?: string[];
    id: string;
    isDefault?: boolean;
    model?: string;
    name?: string;
    tenantIds?: string[];
  };

  /** Build a resolver over fake connection + preference services. */
  function makeResolver(connections: Conn[], prefs: Record<string, { connectionId: string; enforced?: boolean }> = {}) {
    const connectionService = {
      listUsable: async () => connections,
      resolve: async (id?: string) => ({ id: id ?? connections[0]?.id }),
    } as any;
    const preferenceService = {
      getPreference: async (scope: string, refId: string) => prefs[`${scope}:${refId}`] ?? null,
      upsertPreference: async (scope: string, refId: string, connectionId: string, enforced = false) => {
        prefs[`${scope}:${refId}`] = { connectionId, enforced };
        return { connectionId, enforced, refId, scope };
      },
    } as any;
    return new CoreAiConnectionResolverService(connectionService, preferenceService);
  }

  it('no connections → AI disabled (undefined / empty)', async () => {
    const resolver = makeResolver([]);
    expect(await resolver.resolveConnectionId({})).toBeUndefined();
    expect(await resolver.resolveConnection({})).toBeUndefined();
    expect(await resolver.listAvailable({})).toEqual([]);
  });

  it('exactly one connection → it is the implicit default', async () => {
    const resolver = makeResolver([{ id: 'c1', name: 'One' }]);
    expect(await resolver.resolveConnectionId({})).toBe('c1');
  });

  it('layer 1 — global default wins over a non-default connection', async () => {
    const resolver = makeResolver([
      { id: 'c1', name: 'First' },
      { id: 'c2', isDefault: true, name: 'Default' },
    ]);
    expect(await resolver.resolveConnectionId({})).toBe('c2');
  });

  it('layer 2 — tenant default overrides global default', async () => {
    const resolver = makeResolver([{ id: 'c1', isDefault: true }, { id: 'c2' }], {
      'tenant:t1': { connectionId: 'c2' },
    });
    expect(await resolver.resolveConnectionId({ tenantId: 't1' })).toBe('c2');
  });

  it('layer 3 — user default overrides tenant default', async () => {
    const resolver = makeResolver([{ id: 'c1', isDefault: true }, { id: 'c2' }, { id: 'c3' }], {
      'tenant:t1': { connectionId: 'c2' },
      'user:u1': { connectionId: 'c3' },
    });
    expect(await resolver.resolveConnectionId({ tenantId: 't1', userId: 'u1' })).toBe('c3');
  });

  it('layer 4 — client selection overrides user default', async () => {
    const resolver = makeResolver([{ id: 'c1', isDefault: true }, { id: 'c2' }, { id: 'c3' }], {
      'user:u1': { connectionId: 'c2' },
    });
    expect(await resolver.resolveConnectionId({ requested: 'c3', userId: 'u1' })).toBe('c3');
  });

  it('layer 5 — tenant-enforced overrides client selection (and locks)', async () => {
    const resolver = makeResolver([{ id: 'c1' }, { id: 'c2' }], {
      'tenant:t1': { connectionId: 'c2', enforced: true },
    });
    expect(await resolver.resolveConnectionId({ requested: 'c1', tenantId: 't1' })).toBe('c2');
    const available = await resolver.listAvailable({ requested: 'c1', tenantId: 't1' });
    expect(available.find((c) => c.id === 'c2')?.selected).toBe(true);
    expect(available.every((c) => c.locked)).toBe(true);
  });

  it('layer 6 — admin-enforced global overrides tenant-enforced', async () => {
    const resolver = makeResolver([{ id: 'c1' }, { enforced: true, id: 'c2' }], {
      'tenant:t1': { connectionId: 'c1', enforced: true },
    });
    expect(await resolver.resolveConnectionId({ tenantId: 't1' })).toBe('c2');
  });

  it('layer 7 — admin-enforced for tenant overrides admin-enforced global', async () => {
    const resolver = makeResolver([
      { enforced: true, id: 'c1' },
      { enforcedTenantIds: ['t1'], id: 'c2' },
    ]);
    expect(await resolver.resolveConnectionId({ tenantId: 't1' })).toBe('c2');
    // Other tenants still get the global enforced connection.
    expect(await resolver.resolveConnectionId({ tenantId: 't2' })).toBe('c1');
  });

  it('layer 8 — code override wins over everything', async () => {
    const resolver = makeResolver([{ enforced: true, id: 'c1' }, { id: 'c2' }, { id: 'c3' }], {
      'tenant:t1': { connectionId: 'c2', enforced: true },
    });
    expect(await resolver.resolveConnectionId({ codeOverride: 'c3', requested: 'c2', tenantId: 't1' })).toBe('c3');
  });

  it('availability — connections restricted to other tenants are filtered out', async () => {
    const resolver = makeResolver([{ id: 'c1', tenantIds: ['t1'] }, { id: 'c2', tenantIds: ['t2'] }, { id: 'c3' }]);
    const available = await resolver.listAvailable({ tenantId: 't1' });
    expect(available.map((c) => c.id).sort()).toEqual(['c1', 'c3']);
  });

  it('availability — a soft layer pointing to an unavailable connection is ignored', async () => {
    const resolver = makeResolver([
      { id: 'c1', isDefault: true },
      { id: 'c2', tenantIds: ['t2'] },
    ]);
    // Client requests c2, which is not available to tenant t1 → falls back to default c1.
    expect(await resolver.resolveConnectionId({ requested: 'c2', tenantId: 't1' })).toBe('c1');
  });

  it('setUserConnection — validates availability before storing', async () => {
    const prefs: Record<string, { connectionId: string; enforced?: boolean }> = {};
    const resolver = makeResolver([{ id: 'c1' }, { id: 'c2', tenantIds: ['t2'] }], prefs);
    await expect(resolver.setUserConnection('u1', 'c2', 't1')).rejects.toThrow(/not available/);
    await resolver.setUserConnection('u1', 'c1', 't1');
    expect(prefs['user:u1']).toMatchObject({ connectionId: 'c1' });
  });

  it('overridable — a subclass can reorder/replace the chain', async () => {
    class FixedResolver extends CoreAiConnectionResolverService {
      protected override codeOverride(): string | undefined {
        return 'forced';
      }
    }
    const connectionService = { listUsable: async () => [{ id: 'a' }, { id: 'forced' }] } as any;
    const resolver = new FixedResolver(connectionService);
    expect(await resolver.resolveConnectionId({})).toBe('forced');
  });

  it('P1 — a tenant-enforced preference to a missing connection degrades gracefully', async () => {
    // c2 no longer exists; the enforced (hard) layer must not return a dead id.
    const resolver = makeResolver([{ id: 'c1', isDefault: true }], {
      'tenant:t1': { connectionId: 'c2', enforced: true },
    });
    expect(await resolver.resolveConnectionId({ tenantId: 't1' })).toBe('c1');
  });

  it('P1 — a code override to a missing connection degrades gracefully', async () => {
    const resolver = makeResolver([{ id: 'c1', isDefault: true }]);
    expect(await resolver.resolveConnectionId({ codeOverride: 'ghost' })).toBe('c1');
  });

  it('P2 — setPreference rejects a connection that does not exist, accepts an existing one', async () => {
    const resolver = makeResolver([{ id: 'c1' }]);
    await expect(resolver.setPreference('tenant', 't1', 'ghost')).rejects.toThrow(/does not exist/);
    const pref = await resolver.setPreference('tenant', 't1', 'c1', true);
    expect(pref).toMatchObject({ connectionId: 'c1', enforced: true, scope: 'tenant' });
  });

  it('P3 — loads the tenant preference only once per resolution (dedupe)', async () => {
    let tenantQueries = 0;
    const connectionService = { listUsable: async () => [{ id: 'c1' }, { id: 'c2' }] } as any;
    const preferenceService = {
      getPreference: async (scope: string) => {
        if (scope === 'tenant') {
          tenantQueries++;
          return { connectionId: 'c2', enforced: true };
        }
        return null;
      },
    } as any;
    const resolver = new CoreAiConnectionResolverService(connectionService, preferenceService);
    await resolver.resolveConnectionId({ tenantId: 't1', userId: 'u1' });
    // tenantDefault (layer 2) + tenantEnforced (layer 5) share a single DB read.
    expect(tenantQueries).toBe(1);
  });
});

describe('OpenAiCompatibleProvider', () => {
  const baseConn = {
    apiKey: 'sk-x',
    baseUrl: 'https://llm.example.com/v1',
    defaultMaxTokens: 256,
    id: 'c1',
    model: 'm',
    name: 'Test',
    providerType: 'openai-compatible',
  };

  beforeAll(() => {
    new ConfigService({ ai: {} } as any);
  });

  it('auto-detects the context window from the known-model table (no backend)', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('no ollama'); // probe fails → fall back to the heuristic table
    }) as any;
    try {
      expect(await new OpenAiCompatibleProvider({ ...baseConn, model: 'gpt-4o' } as any).detectContextWindow()).toBe(128_000);
      expect(await new OpenAiCompatibleProvider({ ...baseConn, model: 'qwen2.5:14b' } as any).detectContextWindow()).toBe(131_072);
      expect(await new OpenAiCompatibleProvider({ ...baseConn, model: 'totally-unknown' } as any).detectContextWindow()).toBeUndefined();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('derives capabilities from the connection flags', () => {
    const p1 = new OpenAiCompatibleProvider({ ...baseConn } as any);
    expect(p1.capabilities).toEqual({ jsonResponse: false, nativeTools: false, systemPrompt: true });
    const p2 = new OpenAiCompatibleProvider({
      ...baseConn,
      supportsJsonResponse: true,
      supportsNativeTools: true,
    } as any);
    expect(p2.capabilities).toMatchObject({ jsonResponse: true, nativeTools: true });
  });

  it('maps native tool_calls to normalized tool calls (tolerating bad JSON)', () => {
    class Exposed extends OpenAiCompatibleProvider {
      map(tc: any[]) {
        return this.mapNativeToolCalls(tc);
      }
    }
    const p = new Exposed({ ...baseConn } as any);
    expect(
      p.map([
        { function: { arguments: '{"a":1}', name: 'foo' }, id: 'call_1' },
        { function: { arguments: 'not-json', name: 'bar' }, id: 'call_2' },
        { function: { name: '' } },
      ]),
    ).toEqual([
      { arguments: { a: 1 }, id: 'call_1', name: 'foo' },
      { arguments: {}, id: 'call_2', name: 'bar' },
    ]);
  });

  it('returns text + usage on a successful completion', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
        usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
      }),
      ok: true,
    })) as any;
    try {
      const p = new OpenAiCompatibleProvider({ ...baseConn } as any);
      const res = await p.chat([{ content: 'hi', role: 'user' }], []);
      expect(res.text).toBe('hello');
      expect(res.usage).toMatchObject({ completionTokens: 2, promptTokens: 3, totalTokens: 5 });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('maps a transport error to 503 and a non-ok response to 502', async () => {
    const orig = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new Error('boom');
      }) as any;
      const p = new OpenAiCompatibleProvider({ ...baseConn } as any);
      await expect(p.chat([{ content: 'hi', role: 'user' }], [])).rejects.toMatchObject({ status: 503 });

      globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => 'upstream error' })) as any;
      await expect(p.chat([{ content: 'hi', role: 'user' }], [])).rejects.toMatchObject({ status: 502 });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('detectCapabilities probes only undefined flags (json 2xx → true, tools 2xx+tool_calls → true)', async () => {
    const orig = globalThis.fetch;
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.response_format) {
        return { json: async () => ({ choices: [{ message: { content: '{}' } }] }), ok: true };
      }
      if (body.tools) {
        return {
          json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'ping' } }] } }] }),
          ok: true,
        };
      }
      return { json: async () => ({}), ok: true };
    }) as any;
    try {
      const detected = await new OpenAiCompatibleProvider({ ...baseConn } as any).detectCapabilities();
      expect(detected).toEqual({ jsonResponse: true, nativeTools: true });
      expect(bodies.some((b) => b.response_format)).toBe(true);
      expect(bodies.some((b) => b.tool_choice === 'required')).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('detectCapabilities returns false on 4xx and does not probe explicit flags', async () => {
    const orig = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({ ok: false, status: 400 })) as any;
      expect(await new OpenAiCompatibleProvider({ ...baseConn } as any).detectCapabilities()).toEqual({
        jsonResponse: false,
        nativeTools: false,
      });

      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount++;
        return { json: async () => ({}), ok: true };
      }) as any;
      const explicit = new OpenAiCompatibleProvider({
        ...baseConn,
        supportsJsonResponse: true,
        supportsNativeTools: false,
      } as any);
      expect(await explicit.detectCapabilities()).toEqual({});
      expect(fetchCount).toBe(0); // explicit flags are authoritative, never probed
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('detectCapabilities treats 2xx without tool_calls as no native-tool support', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
      ok: true,
    })) as any;
    try {
      const detected = await new OpenAiCompatibleProvider({
        ...baseConn,
        supportsJsonResponse: true,
      } as any).detectCapabilities();
      expect(detected).toEqual({ nativeTools: false });
    } finally {
      globalThis.fetch = orig;
    }
  });

  // Must stay last: sets ai.allowedBaseUrlHosts on the shared ConfigService singleton.
  it('enforces ai.allowedBaseUrlHosts when configured', async () => {
    new ConfigService({ ai: { allowedBaseUrlHosts: ['allowed.example.com'] } } as any);
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      ok: true,
    })) as any;
    try {
      const blocked = new OpenAiCompatibleProvider({ ...baseConn, baseUrl: 'https://evil.example.com/v1' } as any);
      await expect(blocked.chat([{ content: 'hi', role: 'user' }], [])).rejects.toMatchObject({ status: 503 });

      const allowed = new OpenAiCompatibleProvider({ ...baseConn, baseUrl: 'https://allowed.example.com/v1' } as any);
      expect((await allowed.chat([{ content: 'hi', role: 'user' }], [])).text).toBe('ok');
    } finally {
      globalThis.fetch = orig;
      new ConfigService({ ai: { allowedBaseUrlHosts: [] } } as any);
    }
  });
});

describe('CoreAiMcpOAuthService.buildOAuthProvider (wiring)', () => {
  beforeAll(() => {
    new ConfigService({ ai: { mcp: { oauth: true, oauthSecret: 'unit-mcp-oauth-secret-32-characters!!' } } } as any);
  });

  it('exposes the OAuthServerProvider interface and verifies/rejects access tokens', async () => {
    const svc = new CoreAiMcpOAuthService({} as any);
    const provider = svc.buildOAuthProvider(3600);
    expect(typeof provider.clientsStore.getClient).toBe('function');
    expect(typeof provider.clientsStore.registerClient).toBe('function');
    expect(typeof provider.exchangeAuthorizationCode).toBe('function');
    expect(typeof provider.exchangeRefreshToken).toBe('function');
    expect(typeof provider.verifyAccessToken).toBe('function');

    const token = svc.signAccessToken('user-9', 'client-9', 3600);
    await expect(provider.verifyAccessToken(token)).resolves.toMatchObject({
      clientId: 'client-9',
      extra: { userId: 'user-9' },
    });
    await expect(provider.verifyAccessToken('bogus.token')).rejects.toThrow(/invalid_token/);
  });

  it('mountAiMcpOAuth mounts the OAuth router on the app', async () => {
    const { mountAiMcpOAuth } = await import('../../src/core/modules/ai/helpers/ai-mcp-oauth.helper');
    const svc = new CoreAiMcpOAuthService({} as any);
    const used: any[][] = [];
    const app = { get: () => svc, use: (...args: any[]) => used.push(args) };
    await mountAiMcpOAuth(app, { baseUrl: 'https://api.example.com' });
    expect(used).toHaveLength(1);
    expect(used[0][0]).toBeDefined(); // the mcpAuthRouter instance
  });
});

/**
 * OAuth 2.1 flow tests against the persistence layer. The Mongoose connection
 * is replaced by an in-memory fake that mimics the subset of native MongoDB
 * driver methods (`insertOne`, `findOne`, `findOneAndDelete`, `createIndex`).
 *
 * The tests cover the security-critical store contract:
 *   1) authorization-code consume is single-use,
 *   2) `getClient` returns `client_secret` so SDK middleware can verify it,
 *   3) refresh-token rotation is bound to `clientId` (OAuth 2.1 §4.13.2 / §7.4),
 *   4) `exchangeAuthorizationCode` happy path through `buildOAuthProvider`.
 */
describe('CoreAiMcpOAuthService (OAuth 2.1 flow against in-memory store)', () => {
  beforeAll(() => {
    new ConfigService({ ai: { mcp: { oauth: true, oauthSecret: 'unit-oauth-flow-secret-32-chars!!' } } } as any);
  });

  /** In-memory collection: array-backed; `findOneAndDelete` is atomic per call. */
  function makeCollection() {
    const docs: any[] = [];
    const matches = (doc: any, query: any) => Object.keys(query).every((k) => doc[k] === query[k]);
    return {
      docs,
      createIndex: async () => ({}),
      findOne: async (query: any) => docs.find((d) => matches(d, query)) ?? null,
      findOneAndDelete: async (query: any) => {
        const idx = docs.findIndex((d) => matches(d, query));
        if (idx < 0) {
          return null;
        }
        const [removed] = docs.splice(idx, 1);
        return removed;
      },
      insertOne: async (doc: any) => {
        docs.push(doc);
        return { insertedId: doc.client_id ?? doc.code ?? doc.token ?? 'x' };
      },
    };
  }

  function makeConnectionStub() {
    const collections = new Map<string, ReturnType<typeof makeCollection>>();
    return {
      db: {
        collection: (name: string) => {
          if (!collections.has(name)) {
            collections.set(name, makeCollection());
          }
          return collections.get(name)!;
        },
      },
    };
  }

  function makeSvc() {
    return new CoreAiMcpOAuthService(makeConnectionStub() as any);
  }

  it('preserves client_secret across registerClient → getClient roundtrip (BSV-3)', async () => {
    const svc = makeSvc();
    await svc.registerClient({
      client_id: 'cid-confidential',
      client_name: 'Confidential App',
      client_secret: 'top-secret-value',
      client_secret_expires_at: 0,
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    const fetched = await svc.getClient('cid-confidential');
    // Without this fix the SDK's `clientAuth` middleware would skip secret
    // verification because `client.client_secret` is undefined → confidential
    // clients silently downgrade to public clients.
    expect(fetched).toMatchObject({
      client_id: 'cid-confidential',
      client_secret: 'top-secret-value',
      token_endpoint_auth_method: 'client_secret_basic',
    });
  });

  it('public clients have no client_secret (and that is fine — PKCE protects them)', async () => {
    const svc = makeSvc();
    await svc.registerClient({
      client_id: 'cid-public',
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'none',
    });
    const fetched = await svc.getClient('cid-public');
    expect(fetched?.client_secret).toBeUndefined();
    expect(fetched?.token_endpoint_auth_method).toBe('none');
  });

  it('consumeAuthorizationCode is single-use', async () => {
    const svc = makeSvc();
    await svc.saveAuthorizationCode('code-abc', {
      clientId: 'cid-1',
      codeChallenge: 'challenge-1',
      userId: 'uid-1',
    });
    const first = await svc.consumeAuthorizationCode('code-abc');
    expect(first).toMatchObject({ clientId: 'cid-1', codeChallenge: 'challenge-1', userId: 'uid-1' });
    const second = await svc.consumeAuthorizationCode('code-abc');
    expect(second).toBeNull();
  });

  it('rotateRefreshToken with the issuing client succeeds (SEC-001 happy path)', async () => {
    const svc = makeSvc();
    const token = await svc.issueRefreshToken('uid-2', 'cid-2');
    const rotated = await svc.rotateRefreshToken(token, 'cid-2');
    expect(rotated).toMatchObject({ clientId: 'cid-2', userId: 'uid-2' });
    expect(rotated?.newToken).toBeTruthy();
    expect(rotated?.newToken).not.toBe(token);
    // The old token is now invalid (single-use rotation).
    const reuse = await svc.rotateRefreshToken(token, 'cid-2');
    expect(reuse).toBeNull();
  });

  it('rotateRefreshToken rejects a stolen token presented by a different client (SEC-001 fix)', async () => {
    const svc = makeSvc();
    const stolenToken = await svc.issueRefreshToken('uid-victim', 'cid-victim');
    // Attacker (different client) attempts to rotate the stolen token.
    const rotated = await svc.rotateRefreshToken(stolenToken, 'cid-attacker');
    expect(rotated).toBeNull();
    // The legitimate client can still use the token (atomicity preserved).
    const legit = await svc.rotateRefreshToken(stolenToken, 'cid-victim');
    expect(legit).toMatchObject({ clientId: 'cid-victim', userId: 'uid-victim' });
  });

  it('rotateRefreshToken rejects empty token or empty clientId', async () => {
    const svc = makeSvc();
    expect(await svc.rotateRefreshToken('', 'cid-x')).toBeNull();
    expect(await svc.rotateRefreshToken('some-token', '')).toBeNull();
  });

  it('buildOAuthProvider.exchangeAuthorizationCode happy path through the provider', async () => {
    const svc = makeSvc();
    const provider = svc.buildOAuthProvider(60);
    await svc.saveAuthorizationCode('code-flow', {
      clientId: 'cid-flow',
      codeChallenge: 'irrelevant-here',
      userId: 'uid-flow',
    });
    const result = await provider.exchangeAuthorizationCode({ client_id: 'cid-flow' }, 'code-flow');
    expect(result).toMatchObject({ expires_in: 60, token_type: 'Bearer' });
    expect(result.access_token).toBeTruthy();
    expect(result.refresh_token).toBeTruthy();
    // The issued access token round-trips through verifyAccessToken.
    await expect(provider.verifyAccessToken(result.access_token)).resolves.toMatchObject({
      clientId: 'cid-flow',
      extra: { userId: 'uid-flow' },
    });
    // Second use of the same authorization code is rejected.
    await expect(provider.exchangeAuthorizationCode({ client_id: 'cid-flow' }, 'code-flow')).rejects.toThrow(
      /invalid_grant/,
    );
  });

  it('buildOAuthProvider.exchangeAuthorizationCode rejects code from a different client', async () => {
    const svc = makeSvc();
    const provider = svc.buildOAuthProvider();
    await svc.saveAuthorizationCode('code-mismatch', {
      clientId: 'cid-owner',
      codeChallenge: '',
      userId: 'uid-owner',
    });
    await expect(provider.exchangeAuthorizationCode({ client_id: 'cid-other' }, 'code-mismatch')).rejects.toThrow(
      /invalid_grant/,
    );
  });

  it('buildOAuthProvider.exchangeRefreshToken rotates only for the issuing client (SEC-001 end-to-end)', async () => {
    const svc = makeSvc();
    const provider = svc.buildOAuthProvider(60);
    const refresh = await svc.issueRefreshToken('uid-r', 'cid-r');
    // Wrong client → invalid_grant
    await expect(provider.exchangeRefreshToken({ client_id: 'cid-attacker' }, refresh)).rejects.toThrow(
      /invalid_grant/,
    );
    // Right client → success
    const ok = await provider.exchangeRefreshToken({ client_id: 'cid-r' }, refresh);
    expect(ok).toMatchObject({ expires_in: 60, token_type: 'Bearer' });
    // Re-using the rotated (old) refresh token is rejected.
    await expect(provider.exchangeRefreshToken({ client_id: 'cid-r' }, refresh)).rejects.toThrow(/invalid_grant/);
  });

  it('buildOAuthProvider.exchangeRefreshToken rejects an empty client', async () => {
    const svc = makeSvc();
    const provider = svc.buildOAuthProvider();
    await expect(provider.exchangeRefreshToken({}, 'any-token')).rejects.toThrow(/invalid_client/);
  });

  it('challengeForAuthorizationCode returns the stored PKCE challenge (does not consume)', async () => {
    const svc = makeSvc();
    const provider = svc.buildOAuthProvider();
    await svc.saveAuthorizationCode('code-pkce', {
      clientId: 'cid-pkce',
      codeChallenge: 'the-challenge',
      userId: 'uid-pkce',
    });
    expect(await provider.challengeForAuthorizationCode({}, 'code-pkce')).toBe('the-challenge');
    // The code is still present for the subsequent exchange.
    const result = await provider.exchangeAuthorizationCode({ client_id: 'cid-pkce' }, 'code-pkce');
    expect(result.access_token).toBeTruthy();
  });
});

describe('ClaudeCliProvider', () => {
  const baseConn = {
    apiKey: '',
    baseUrl: '',
    id: 'cc1',
    model: 'sonnet',
    name: 'Claude CLI',
    providerType: 'claude-cli',
  };

  beforeAll(() => {
    new ConfigService({ ai: {} } as any);
  });

  /** Subclass that captures the spawned argv/stdin and returns a canned stdout. */
  class FakeCli extends ClaudeCliProvider {
    lastArgs: string[] = [];
    lastInput = '';
    stdout = JSON.stringify({ result: 'hi there', subtype: 'success', usage: { input_tokens: 11, output_tokens: 4 } });
    expose(system: string) {
      return this.buildArgs(system);
    }
    protected override run(args: string[], input: string): Promise<string> {
      this.lastArgs = args;
      this.lastInput = input;
      return Promise.resolve(this.stdout);
    }
  }

  it('auto-detects a Claude context window from the model alias', async () => {
    expect(await new ClaudeCliProvider({ model: 'sonnet', name: 'C', providerType: 'claude-cli' } as any).detectContextWindow()).toBe(200_000);
    expect(await new ClaudeCliProvider({ model: 'opus[1m]', name: 'C', providerType: 'claude-cli' } as any).detectContextWindow()).toBe(1_000_000);
  });

  it('runs tool-free and emulated (capabilities nativeTools=false, jsonResponse=false)', () => {
    const p = new ClaudeCliProvider({ ...baseConn } as any);
    expect(p.capabilities).toEqual({ jsonResponse: false, nativeTools: false, systemPrompt: true });
    expect(p.name).toBe('claude-cli');
  });

  it('always disables the CLI tools and replaces the system prompt', () => {
    const p = new FakeCli({ ...baseConn } as any);
    const args = p.expose('SYSTEM PROMPT');
    // `--tools ""` must always be present (CLI runs without its own tools)
    const toolsIdx = args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(args[toolsIdx + 1]).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--system-prompt');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYSTEM PROMPT');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args).toContain('-p');
  });

  it('parses result + usage and flattens the transcript to stdin', async () => {
    const p = new FakeCli({ ...baseConn } as any);
    const res = await p.chat(
      [
        { content: 'sys', role: 'system' },
        { content: 'hello', role: 'user' },
        { content: 'prev answer', role: 'assistant' },
      ],
      [],
    );
    expect(res.text).toBe('hi there');
    expect(res.usage).toMatchObject({ completionTokens: 4, promptTokens: 11, totalTokens: 15 });
    // system goes to --system-prompt, the rest to the stdin transcript
    expect(p.lastInput).toContain('User:');
    expect(p.lastInput).toContain('hello');
    expect(p.lastInput).toContain('Assistant:');
    expect(p.lastInput).not.toContain('sys');
  });

  it('maps a CLI error result to a gateway error', async () => {
    const p = new FakeCli({ ...baseConn } as any);
    p.stdout = JSON.stringify({ is_error: true, subtype: 'error_during_execution' });
    await expect(p.chat([{ content: 'hi', role: 'user' }], [])).rejects.toMatchObject({ status: 502 });
  });

  it('maps non-JSON CLI output to a gateway error', async () => {
    const p = new FakeCli({ ...baseConn } as any);
    p.stdout = 'not json at all';
    await expect(p.chat([{ content: 'hi', role: 'user' }], [])).rejects.toMatchObject({ status: 502 });
  });

  it('maps a spawn/transport failure to 503', async () => {
    class FailingCli extends ClaudeCliProvider {
      protected override run(): Promise<string> {
        return Promise.reject(new Error('spawn ENOENT'));
      }
    }
    const p = new FailingCli({ ...baseConn } as any);
    await expect(p.chat([{ content: 'hi', role: 'user' }], [])).rejects.toMatchObject({ status: 503 });
  });

  it('is registrable on the factory and built for claude-cli connections', () => {
    const factory = new LlmProviderFactory();
    factory.registerBuilder('claude-cli', (conn) => new ClaudeCliProvider(conn));
    expect(factory.supports('claude-cli')).toBe(true);
    const provider = factory.create({ ...baseConn } as any);
    expect(provider).toBeInstanceOf(ClaudeCliProvider);
    expect(provider.capabilities.nativeTools).toBe(false);
  });
});
