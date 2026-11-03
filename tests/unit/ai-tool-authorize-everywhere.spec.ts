import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { ErrorCode } from '../../src/core/modules/error-code/index';
import { AiHookRegistry } from '../../src/core/modules/ai/hooks/ai-hook.registry';
import { IAiTool } from '../../src/core/modules/ai/interfaces/ai-tool.interface';
import { ILlmProvider, LlmResponse } from '../../src/core/modules/ai/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '../../src/core/modules/ai/providers/llm-provider.factory';
import { CoreAiMcpService } from '../../src/core/modules/ai/services/core-ai-mcp.service';
import { CoreAiPromptBuilderService } from '../../src/core/modules/ai/services/core-ai-prompt-builder.service';
import { CoreAiService } from '../../src/core/modules/ai/services/core-ai.service';
import { CoreAiToolPolicyService } from '../../src/core/modules/ai/services/core-ai-tool-policy.service';
import { CoreAiUserSettingService } from '../../src/core/modules/ai/services/core-ai-user-setting.service';
import { AiToolRegistry } from '../../src/core/modules/ai/tools/ai-tool.registry';

/**
 * `AiTool.authorize()` and the confirmation flags hold on EVERY path a tool is executed on.
 *
 * Until 12.3.0 `authorize()` ran in plan mode only: auto mode (the default) and the MCP endpoint called `execute()`
 * directly, so a data-level check a tool author placed there ("may this user delete record 42?") never ran for most
 * callers. MCP additionally ignored `destructive` / `mutating`, so a destructive tool ran on the first call.
 *
 * Now every execution authorizes first (on the arguments that are executed, after the PreToolUse hooks), a thrown
 * `authorize()` counts as a refusal, and MCP asks the user through MCP elicitation before a tool that needs
 * confirmation runs — or refuses when the client cannot ask. Whether MCP asks is `ai.mcp.confirmation` (on by
 * default), which each user may switch for themselves like a "bypass permissions" mode unless the server enforces it;
 * an admin's `ask` / `deny` tool policy applies over MCP as in the chat.
 */

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

function buildService(provider: ILlmProvider, registry: AiToolRegistry, hookRegistry?: AiHookRegistry) {
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
  return new CoreAiService(
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
    hookRegistry,
  );
}

const user = { id: 'user-1', roles: [RoleEnum.ADMIN] };

/** A tool with a data-level check, recording what reached `execute()` */
function recordTool(
  name: string,
  authorize: IAiTool['authorize'],
  flags: Partial<Pick<IAiTool, 'destructive' | 'mutating'>> = {},
) {
  const executed: { args: Record<string, any>; authorization: unknown }[] = [];
  const tool: IAiTool = {
    authorize,
    description: `tool ${name}`,
    execute: async (args, context) => {
      executed.push({ args, authorization: (context as any).authorization });
      return { data: { done: true }, success: true };
    },
    name,
    parameters: { properties: { id: { type: 'string' } }, type: 'object' },
    roles: [RoleEnum.S_USER],
    ...flags,
  };
  return { executed, tool };
}

/** Replaces the whole configuration (the constructor would merge into the previous test's) */
function configure(ai: Record<string, unknown>) {
  ConfigService.setConfig({ ai } as any, { reInit: true });
}

/** The real settings service on an in-memory store, so its effective-value rules are the ones under test */
class MemorySettingsService extends CoreAiUserSettingService {
  readonly rows: Record<string, any>[] = [];

  constructor() {
    super(undefined as any, undefined as any);
  }

  protected override get dataStore(): any {
    const rows = this.rows;
    return {
      findOne: async (where: Record<string, any>) => rows.find((r) => r.userId === where.userId) ?? null,
      insert: async (record: Record<string, any>) => {
        rows.push({ ...record });
        return record;
      },
      updateOne: async (where: Record<string, any>, update: { $set: Record<string, any> }) => {
        const row = rows.find((r) => r.userId === where.userId);
        return row ? Object.assign(row, update.$set) : null;
      },
    };
  }
}

describe('personal AI settings (CoreAiUserSettingService)', () => {
  afterEach(() => configure({}));

  it('answers the server default until the user chose, then their choice', async () => {
    const settings = new MemorySettingsService();

    expect(await settings.getSettings(user.id)).toEqual({ mcpConfirmation: true, mcpConfirmationEnforced: false });
    expect(await settings.updateSettings(user.id, { mcpConfirmation: false })).toEqual({
      mcpConfirmation: false,
      mcpConfirmationEnforced: false,
    });
    expect(await settings.updateSettings(user.id, { mcpConfirmation: true })).toMatchObject({ mcpConfirmation: true });
    expect(settings.rows).toEqual([{ mcpConfirmation: true, userId: user.id }]);
  });

  /**
   * @regression   12.3.0 — a setting the server enforces must be refused, not stored and silently ignored.
   * @seen-failing Drop the `enforced` check in updateSettings()
   *   (src/core/modules/ai/services/core-ai-user-setting.service.ts) — registered as mutation
   *   `ai-settings-enforced-stored` in tests/regression-mutations.json.
   */
  it('refuses a change of an enforced setting with 403 and stores nothing', async () => {
    configure({ mcp: { confirmation: { default: true, enforced: true } } });
    const settings = new MemorySettingsService();

    await expect(settings.updateSettings(user.id, { mcpConfirmation: false })).rejects.toMatchObject({
      message: ErrorCode.AI_SETTING_ENFORCED,
      status: 403,
    });
    expect(settings.rows).toEqual([]);
    expect(await settings.getSettings(user.id)).toEqual({ mcpConfirmation: true, mcpConfirmationEnforced: true });
  });

  it('reads the configuration safely: only false switches the default off, only true enforces', async () => {
    const settings = new MemorySettingsService();
    const cases: [unknown, { mcpConfirmation: boolean; mcpConfirmationEnforced: boolean }][] = [
      [undefined, { mcpConfirmation: true, mcpConfirmationEnforced: false }],
      [true, { mcpConfirmation: true, mcpConfirmationEnforced: false }],
      [false, { mcpConfirmation: false, mcpConfirmationEnforced: false }],
      ['false', { mcpConfirmation: true, mcpConfirmationEnforced: false }],
      [{}, { mcpConfirmation: true, mcpConfirmationEnforced: false }],
      [
        { default: false, enforced: true },
        { mcpConfirmation: false, mcpConfirmationEnforced: true },
      ],
      [
        { default: 'no', enforced: 'yes' },
        { mcpConfirmation: true, mcpConfirmationEnforced: false },
      ],
    ];
    for (const [confirmation, expected] of cases) {
      configure({ mcp: { confirmation } });
      expect(await settings.getSettings(user.id)).toEqual(expected);
    }
  });
});

describe('AiTool.authorize() on every execution path', () => {
  afterEach(() => configure({}));

  /**
   * @regression   12.3.0 — auto mode, the default, called `execute()` without `authorize()`, so a data-level check
   *   placed there ran in plan mode only.
   * @seen-failing Skip the authorizeCall() check in executeToolCall()
   *   (src/core/modules/ai/services/core-ai.service.ts) — registered as mutation
   *   `ai-auto-mode-skips-authorize` in tests/regression-mutations.json.
   */
  it('auto mode: refuses a call authorize() denies, without executing it', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('edit_record', async () => ({ allowed: false, reason: 'not the owner' }));
    registry.register(tool);
    const provider = new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: { id: 'x' }, name: 'edit_record' }] }),
      JSON.stringify({ final: 'could not edit' }),
    ]);

    const response = await buildService(provider, registry).prompt({ prompt: 'edit x' } as any, { currentUser: user });

    expect(executed).toEqual([]);
    expect(response.actions?.[0]).toMatchObject({
      name: 'edit_record',
      result: { error: { code: 'TOOL_NOT_AVAILABLE', message: expect.stringContaining('not the owner') } },
      success: false,
    });
  });

  /**
   * @regression   12.3.0 — a thrown `authorize()` must refuse the call, not let it through.
   * @seen-failing Return `{ allowed: true }` from the catch in authorizeToolCall()
   *   (src/core/modules/ai/helpers/ai-tool-authorization.helper.ts) — registered as mutation
   *   `ai-authorize-throw-allows` in tests/regression-mutations.json.
   */
  it('auto mode: a thrown authorize() is a refusal, never an execution', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('edit_record', async () => {
      throw new Error('lookup failed');
    });
    registry.register(tool);
    const provider = new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: { id: 'x' }, name: 'edit_record' }] }),
      JSON.stringify({ final: 'could not edit' }),
    ]);

    const response = await buildService(provider, registry).prompt({ prompt: 'edit x' } as any, { currentUser: user });

    expect(executed).toEqual([]);
    expect(response.actions?.[0]).toMatchObject({ name: 'edit_record', success: false });
  });

  it('auto mode: authorizes the arguments a PreToolUse hook rewrote, and hands the decision to execute()', async () => {
    const registry = new AiToolRegistry();
    const seen: Record<string, any>[] = [];
    const { executed, tool } = recordTool('edit_record', async (args) => {
      seen.push({ ...args });
      return { allowed: true, data: { record: args.id } };
    });
    registry.register(tool);
    const hooks = new AiHookRegistry();
    hooks.register({ name: 'sanitize', preToolUse: async () => ({ args: { id: 'sanitized' } }) });
    const provider = new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: { id: 'raw' }, name: 'edit_record' }] }),
      JSON.stringify({ final: 'edited' }),
    ]);

    await buildService(provider, registry, hooks).prompt({ prompt: 'edit' } as any, { currentUser: user });

    expect(seen).toEqual([{ id: 'sanitized' }]);
    expect(executed).toEqual([
      { args: { id: 'sanitized' }, authorization: { allowed: true, data: { record: 'sanitized' } } },
    ]);
  });

  it('auto mode: a tool without authorize() runs as before', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('read_record', undefined);
    registry.register(tool);
    const provider = new ScriptedProvider([
      JSON.stringify({ tool_calls: [{ arguments: { id: 'x' }, name: 'read_record' }] }),
      JSON.stringify({ final: 'read' }),
    ]);

    const response = await buildService(provider, registry).prompt({ prompt: 'read' } as any, { currentUser: user });

    expect(executed).toHaveLength(1);
    expect(response.text).toBe('read');
  });
});

describe('MCP tools/call: authorize() and the confirmation gate', () => {
  afterEach(() => configure({}));

  /**
   * @regression   12.3.0 — `mcpCallTool()` called `execute()` without `authorize()`.
   * @seen-failing Skip the authorization check in mcpCallTool()
   *   (src/core/modules/ai/services/core-ai-mcp.service.ts) — registered as mutation
   *   `ai-mcp-skips-authorize` in tests/regression-mutations.json.
   */
  it('refuses a call authorize() denies, without executing it', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('edit_record', async () => ({ allowed: false, reason: 'not the owner' }));
    registry.register(tool);

    const result = await new CoreAiMcpService(registry).mcpCallTool(user, 'edit_record', { id: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not the owner');
    expect(executed).toEqual([]);
  });

  /**
   * @regression   12.3.0 — a destructive tool ran over MCP on the first call; `destructive` and `mutating` were read
   *   by the chat orchestrator only.
   * @seen-failing Skip the confirmation gate in mcpCallTool()
   *   (src/core/modules/ai/services/core-ai-mcp.service.ts) — registered as mutation
   *   `ai-mcp-skips-confirmation` in tests/regression-mutations.json.
   */
  it('refuses a destructive tool when the client cannot ask the user, without executing it', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('delete_record', undefined, { destructive: true });
    registry.register(tool);

    const result = await new CoreAiMcpService(registry).mcpCallTool(user, 'delete_record', { id: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('confirm');
    expect(executed).toEqual([]);
  });

  it('runs a destructive tool only after the user confirmed it', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('delete_record', undefined, { destructive: true });
    registry.register(tool);
    const mcp = new CoreAiMcpService(registry);
    const prompts: string[] = [];

    const declined = await mcp.mcpCallTool(
      user,
      'delete_record',
      { id: 'x' },
      {
        confirm: async (prompt) => {
          prompts.push(prompt.message);
          return false;
        },
      },
    );
    expect(declined.isError).toBe(true);
    expect(executed).toEqual([]);
    expect(prompts[0]).toContain('delete_record');

    const confirmed = await mcp.mcpCallTool(user, 'delete_record', { id: 'x' }, { confirm: async () => true });
    expect(confirmed.isError).toBeFalsy();
    expect(executed).toHaveLength(1);
  });

  it('treats a failing confirmation prompt as "not confirmed"', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('delete_record', undefined, { destructive: true });
    registry.register(tool);

    const result = await new CoreAiMcpService(registry).mcpCallTool(
      user,
      'delete_record',
      {},
      {
        confirm: async () => {
          throw new Error('client went away');
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(executed).toEqual([]);
  });

  it('gates a mutating tool by ai.confirmation.mutating, and runs it without a policy', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('update_record', undefined, { mutating: true });
    registry.register(tool);
    const mcp = new CoreAiMcpService(registry);

    expect((await mcp.mcpCallTool(user, 'update_record', {})).isError).toBeFalsy();
    expect(executed).toHaveLength(1);

    configure({ confirmation: { mutating: { default: true } } });
    expect((await mcp.mcpCallTool(user, 'update_record', {})).isError).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('asks nobody with ai.mcp.confirmation: false, and still authorizes', async () => {
    configure({ mcp: { confirmation: false } });
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('delete_record', async (args) => args.id !== 'foreign', {
      destructive: true,
    });
    registry.register(tool);
    const mcp = new CoreAiMcpService(registry);

    expect((await mcp.mcpCallTool(user, 'delete_record', { id: 'x' })).isError).toBeFalsy();
    expect((await mcp.mcpCallTool(user, 'delete_record', { id: 'foreign' })).isError).toBe(true);
    expect(executed.map((e) => e.args.id)).toEqual(['x']);
  });

  /**
   * @regression   12.3.0 — a user's own "do not ask me" switch must be honoured, and must not outlive an
   *   `enforced` policy.
   * @seen-failing Ignore `enforced` in effectiveMcpConfirmation()
   *   (src/core/modules/ai/helpers/ai-tool-authorization.helper.ts) — registered as mutation
   *   `ai-mcp-user-bypass-ignores-enforced` in tests/regression-mutations.json.
   */
  it("follows the user's own switch, unless the server enforces the policy", async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('delete_record', undefined, { destructive: true });
    registry.register(tool);
    const settings = new MemorySettingsService();
    const mcp = new CoreAiMcpService(registry, settings);

    await settings.updateSettings(user.id, { mcpConfirmation: false });
    expect((await mcp.mcpCallTool(user, 'delete_record', {})).isError).toBeFalsy();
    expect(executed).toHaveLength(1);

    // Another user keeps the server default
    const other = { id: 'user-2', roles: [RoleEnum.ADMIN] };
    expect((await mcp.mcpCallTool(other, 'delete_record', {})).isError).toBe(true);

    configure({ mcp: { confirmation: { enforced: true } } });
    expect((await mcp.mcpCallTool(user, 'delete_record', {})).isError).toBe(true);
    expect(executed).toHaveLength(1);
    // The stored choice stays, but no longer takes effect — and the user sees why
    expect(await settings.getSettings(user.id)).toEqual({ mcpConfirmation: true, mcpConfirmationEnforced: true });
  });

  it('lets a user switch confirmation on where the server default is off', async () => {
    configure({ mcp: { confirmation: false } });
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('delete_record', undefined, { destructive: true });
    registry.register(tool);
    const settings = new MemorySettingsService();
    await settings.updateSettings(user.id, { mcpConfirmation: true });

    const result = await new CoreAiMcpService(registry, settings).mcpCallTool(user, 'delete_record', {});

    expect(result.isError).toBe(true);
    expect(executed).toEqual([]);
  });

  /**
   * @regression   12.3.0 — the admin's tool policies were evaluated by the chat orchestrator only, so a `deny` rule
   *   did not stop the same call over MCP.
   * @seen-failing Skip the policy evaluation in mcpCallTool()
   *   (src/core/modules/ai/services/core-ai-mcp.service.ts) — registered as mutation
   *   `ai-mcp-skips-tool-policy` in tests/regression-mutations.json.
   */
  it("applies the admin's tool policies: deny refuses, ask asks even a user who switched confirmation off", async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('update_record', undefined);
    registry.register(tool);
    const settings = new MemorySettingsService();
    await settings.updateSettings(user.id, { mcpConfirmation: false });
    const decisions: Record<string, { decision: 'allow' | 'ask' | 'deny'; reason?: string }> = {
      asked: { decision: 'ask' },
      denied: { decision: 'deny', reason: 'blocked by the admin' },
    };
    const policies = {
      evaluate: async (_tool: string, args: Record<string, any>) => decisions[args.id],
    } as unknown as CoreAiToolPolicyService;
    const mcp = new CoreAiMcpService(registry, settings, policies);

    const denied = await mcp.mcpCallTool(user, 'update_record', { id: 'denied' }, { confirm: async () => true });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('blocked by the admin');

    expect((await mcp.mcpCallTool(user, 'update_record', { id: 'asked' })).isError).toBe(true);
    expect(
      (await mcp.mcpCallTool(user, 'update_record', { id: 'asked' }, { confirm: async () => true })).isError,
    ).toBeFalsy();
    expect((await mcp.mcpCallTool(user, 'update_record', { id: 'free' })).isError).toBeFalsy();
    expect(executed.map((e) => e.args.id)).toEqual(['asked', 'free']);
  });

  /**
   * @regression   12.3.0 — a tool without `mutating` / `destructive` may still write (the flags used to matter for the
   *   chat only), so it must not be advertised as read-only: a client may run a read-only tool without asking.
   * @seen-failing Advertise `readOnlyHint: true` for unflagged tools in mcpListTools()
   *   (src/core/modules/ai/services/core-ai-mcp.service.ts) — registered as mutation
   *   `ai-mcp-unflagged-tool-read-only` in tests/regression-mutations.json.
   */
  it('marks mutating and destructive tools for MCP clients, and never claims an unflagged tool is read-only', () => {
    const registry = new AiToolRegistry();
    registry.register(recordTool('read_record', undefined).tool);
    registry.register(recordTool('update_record', undefined, { mutating: true }).tool);
    registry.register(recordTool('delete_record', undefined, { destructive: true }).tool);

    const annotations = Object.fromEntries(
      new CoreAiMcpService(registry).mcpListTools(user).map((t) => [t.name, t.annotations]),
    );

    expect(annotations).toEqual({
      delete_record: { destructiveHint: true, readOnlyHint: false },
      read_record: undefined,
      update_record: { destructiveHint: false, readOnlyHint: false },
    });
  });

  /**
   * @regression   12.3.0 — the arguments come from the model, so the question must show every one of them: a cut over
   *   the whole argument text let a long first value push the target id out of what the user approves.
   * @seen-failing Cut the whole argument text in confirmationPrompt()
   *   (src/core/modules/ai/services/core-ai-mcp.service.ts) — registered as mutation
   *   `ai-mcp-confirmation-hides-arguments` in tests/regression-mutations.json.
   */
  it('shows every argument in the confirmation question, however long the one before it', async () => {
    const registry = new AiToolRegistry();
    registry.register(recordTool('delete_record', undefined, { destructive: true }).tool);
    let message = '';

    await new CoreAiMcpService(registry).mcpCallTool(
      user,
      'delete_record',
      { note: 'x'.repeat(5000), userId: 'victim-42' },
      {
        confirm: async (prompt) => {
          message = prompt.message;
          return false;
        },
      },
    );

    expect(message).toContain('userId: victim-42');
    expect(message).toContain('(5000 characters)');
    expect(message.length).toBeLessThan(600);
  });
});

describe('MCP confirmation through the SDK (elicitation)', () => {
  afterEach(() => configure({}));

  /** Connects an SDK client to `createServer()`; `answer` decides the user's reply to an elicitation */
  async function connect(registry: AiToolRegistry, answer?: 'accept' | 'decline') {
    const server = await new CoreAiMcpService(registry).createServer(user);
    const client = new Client(
      { name: 'unit-test-client', version: '1.0.0' },
      { capabilities: answer ? { elicitation: {} } : {} },
    );
    const elicitations: string[] = [];
    if (answer) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        elicitations.push(request.params.message);
        return answer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
      });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, elicitations, server };
  }

  it('asks the user and runs the destructive tool after they accept', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('delete_record', undefined, { destructive: true });
    registry.register(tool);
    const { client, elicitations } = await connect(registry, 'accept');

    const result: any = await client.callTool({ arguments: { id: 'x' }, name: 'delete_record' });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    expect(executed).toHaveLength(1);
    await client.close();
  });

  /**
   * @regression   12.3.0 — only an accepted elicitation with `confirm: true` may run the tool.
   * @seen-failing Return `true` from elicitConfirmation()
   *   (src/core/modules/ai/services/core-ai-mcp.service.ts) — registered as mutation
   *   `ai-mcp-elicit-decline-runs` in tests/regression-mutations.json.
   */
  it('does not run the destructive tool when the user declines', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('delete_record', undefined, { destructive: true });
    registry.register(tool);
    const { client, elicitations } = await connect(registry, 'decline');

    const result: any = await client.callTool({ arguments: { id: 'x' }, name: 'delete_record' });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(executed).toEqual([]);
    await client.close();
  });

  it('refuses the destructive tool for a client without elicitation', async () => {
    const registry = new AiToolRegistry();
    const { executed, tool } = recordTool('delete_record', undefined, { destructive: true });
    registry.register(tool);
    const { client } = await connect(registry);

    const result: any = await client.callTool({ arguments: { id: 'x' }, name: 'delete_record' });

    expect(result.isError).toBe(true);
    expect(executed).toEqual([]);
    await client.close();
  });
});
