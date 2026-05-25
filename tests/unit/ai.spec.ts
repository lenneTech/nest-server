import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { IAiTool } from '../../src/core/modules/ai/interfaces/ai-tool.interface';
import { ILlmProvider, LlmResponse } from '../../src/core/modules/ai/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '../../src/core/modules/ai/providers/llm-provider.factory';
import { AiCryptoService } from '../../src/core/modules/ai/services/ai-crypto.service';
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
  readonly name = 'fake';
  readonly supportsNativeTools = false;
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
});

describe('AiToolRegistry', () => {
  it('filters tools by the user roles', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool('pub', [RoleEnum.S_EVERYONE]));
    registry.register(makeTool('user', [RoleEnum.S_USER]));
    registry.register(makeTool('admin', [RoleEnum.ADMIN]));
    registry.register(makeTool('locked', [RoleEnum.S_NO_ONE]));

    expect(registry.forUser(null).map((t) => t.name)).toEqual(['pub']);
    expect(registry.forUser({ id: '1', roles: [] }).map((t) => t.name).sort()).toEqual(['pub', 'user']);

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
  it('enriches the system prompt with the user permissions, tools and documentation', () => {
    new ConfigService({ ai: { documentation: 'DOC-MARKER-123', systemPrompt: 'BASE-PROMPT' } } as any);
    const builder = new CoreAiPromptBuilderService();
    const prompt = builder.buildSystemPrompt([makeTool('do_thing', [RoleEnum.S_USER])], false, {
      id: 'u1',
      roles: ['admin', 'editor'],
    });
    expect(prompt).toContain('BASE-PROMPT');
    expect(prompt).toContain('DOC-MARKER-123');
    expect(prompt).toContain('admin');
    expect(prompt).toContain('editor');
    expect(prompt).toContain('do_thing');
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
    const response = await service.prompt(
      { prompt: 'how many users are there?' } as any,
      { currentUser: { id: 'admin-1', roles: [RoleEnum.ADMIN] } },
    );

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
    const response = await service.prompt(
      { prompt: 'use the admin tool' } as any,
      { currentUser: { id: 'user-1', roles: [] } },
    );

    // The tool was rejected (not in the user's available set) → action marked unsuccessful.
    expect(response.actions?.[0]).toMatchObject({ name: 'admin_only', success: false });
    expect(response.text).toBe('Sorry, I cannot do that.');
  });

  it('plan mode executes a fully-permitted multi-step plan', async () => {
    const executed: string[] = [];
    const registry = new AiToolRegistry();
    registry.register(makeTool('read_a', [RoleEnum.S_USER], async () => {
      executed.push('read_a');
      return { data: { a: 1 }, success: true };
    }));
    registry.register(makeTool('read_b', [RoleEnum.S_USER], async () => {
      executed.push('read_b');
      return { data: { b: 2 }, success: true };
    }));

    const provider = new ScriptedProvider([
      JSON.stringify({ plan: [{ arguments: {}, name: 'read_a' }, { arguments: {}, name: 'read_b' }], summary: 'read both' }),
      JSON.stringify({ final: 'Both read.' }),
    ]);
    const response = await buildService(provider, registry).prompt(
      { mode: 'plan', prompt: 'read a and b' } as any,
      { currentUser: { id: 'u1', roles: [] } },
    );

    expect(executed).toEqual(['read_a', 'read_b']);
    expect(response.denied).toBeFalsy();
    expect(response.plan?.map((a) => a.name)).toEqual(['read_a', 'read_b']);
    expect(response.actions).toHaveLength(2);
    expect(response.text).toBe('Both read.');
  });

  it('plan mode executes NOTHING and returns a translated error if one step is not permitted (pre-flight)', async () => {
    const executed: string[] = [];
    const registry = new AiToolRegistry();
    registry.register(makeTool('read_a', [RoleEnum.S_USER], async () => {
      executed.push('read_a');
      return { data: { a: 1 }, success: true };
    }));
    registry.register(makeTool('admin_only', [RoleEnum.ADMIN], async () => {
      executed.push('admin_only');
      return { success: true };
    }));

    const provider = new ScriptedProvider([
      JSON.stringify({ plan: [{ arguments: {}, name: 'read_a' }, { arguments: {}, name: 'admin_only' }], summary: 'x' }),
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
    const response = await buildService(provider, registry).prompt(
      { mode: 'plan', prompt: 'edit x' } as any,
      { currentUser: { id: 'u1', roles: [RoleEnum.S_USER] } },
    );

    expect(executed).toEqual([]);
    expect(response.denied).toBe(true);
    expect(response.deniedActions?.[0]).toMatchObject({ name: 'edit_record' });
  });

  it('blocks a run when the daily budget is exceeded (translated message)', async () => {
    new ConfigService({ ai: { budget: { maxPromptsPerDay: 3 }, maxIterations: 5 } } as any);
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => new ScriptedProvider([JSON.stringify({ final: 'ok' })]));
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://fake', id: 'c1', model: 'fake', name: 'F', providerType: 'fake' }),
    } as any;
    const interactionService = { record: async () => undefined, usageSince: async () => ({ prompts: 3, tokens: 0 }) } as any;
    const service = new CoreAiService(
      connectionService,
      factory,
      new AiToolRegistry(),
      new CoreAiPromptBuilderService(),
      interactionService,
    );

    await expect(
      service.prompt({ prompt: 'hi' } as any, { currentUser: { id: 'u1', roles: [] }, language: 'de' }),
    ).rejects.toThrow(/Kontingent/);
  });

  it('allows a run when under the daily budget', async () => {
    new ConfigService({ ai: { budget: { maxPromptsPerDay: 10 }, maxIterations: 5 } } as any);
    const factory = new LlmProviderFactory();
    factory.registerBuilder('fake', () => new ScriptedProvider([JSON.stringify({ final: 'fine' })]));
    const connectionService = {
      resolve: async () => ({ apiKey: '', baseUrl: 'http://fake', id: 'c1', model: 'fake', name: 'F', providerType: 'fake' }),
    } as any;
    const interactionService = { record: async () => undefined, usageSince: async () => ({ prompts: 2, tokens: 0 }) } as any;
    const service = new CoreAiService(
      connectionService,
      factory,
      new AiToolRegistry(),
      new CoreAiPromptBuilderService(),
      interactionService,
    );

    const response = await service.prompt({ prompt: 'hi' } as any, { currentUser: { id: 'u1', roles: [] } });
    expect(response.text).toBe('fine');
  });

  it('treats plain text (no JSON protocol) as the final answer', async () => {
    const registry = new AiToolRegistry();
    const provider = new ScriptedProvider(['Just a plain answer.']);
    const service = buildService(provider, registry);
    const response = await service.prompt(
      { prompt: 'hello' } as any,
      { currentUser: { id: 'user-1', roles: [] } },
    );
    expect(response.text).toBe('Just a plain answer.');
    expect(response.actions).toHaveLength(0);
  });

  it('includes client metadata (url, console logs) in the prompt sent to the LLM', async () => {
    const captured: string[] = [];
    const provider: ILlmProvider = {
      name: 'fake',
      supportsNativeTools: false,
      async chat(messages) {
        captured.push(messages.map((m) => m.content).join(' || '));
        return { text: JSON.stringify({ final: 'ok' }), usage: {} };
      },
    };
    await buildService(provider, new AiToolRegistry()).prompt(
      { metadata: { consoleLogs: ['ReferenceError at line 7'], url: '/orders/42' }, prompt: 'why does this page fail?' } as any,
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

    const adminTools = mcp.mcpListTools({ id: 'a', roles: [RoleEnum.ADMIN] }).map((t) => t.name).sort();
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
    const responseA = await buildService(providerA, registry).prompt(
      { prompt: 'delete user x' } as any,
      { currentUser: { id: 'admin-1', roles: [RoleEnum.ADMIN] } },
    );
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
    new ConfigService({ ai: { confirmation: { mutating: { default: true, enforced: true } }, maxIterations: 5 } } as any);
    const executed: string[] = [];
    const response = await buildService(mutatingProvider(), mutatingRegistry(executed)).prompt(
      { prompt: 'create x', requireConfirmation: false } as any,
      { currentUser: { id: 'u1', roles: [RoleEnum.S_USER] } },
    );
    expect(executed).toEqual([]);
    expect(response.requiresConfirmation).toBe(true);
  });
});
