import { createHash } from 'node:crypto';

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
