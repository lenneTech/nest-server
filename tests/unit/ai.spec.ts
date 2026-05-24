import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { IAiTool } from '../../src/core/modules/ai/interfaces/ai-tool.interface';
import { ILlmProvider, LlmResponse } from '../../src/core/modules/ai/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '../../src/core/modules/ai/providers/llm-provider.factory';
import { AiCryptoService } from '../../src/core/modules/ai/services/ai-crypto.service';
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
});
