/**
 * Tool interop (nestjs-ai plan §3): `@nestjs/ai` agent functions as AI tools (`ai.agentFunctions`), and Standard
 * Schema parameters for the framework's own tools.
 */
import { INestApplication, Injectable, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AgentFunction, AiModule } from '@nestjs/ai';
import { FakeModel } from '@nestjs/ai/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { RequestContext } from '../../src/core/common/services/request-context.service';
import { AiAgentFunction } from '../../src/core/modules/ai/decorators/ai-agent-function.decorator';
import { authorizeToolCall } from '../../src/core/modules/ai/helpers/ai-tool-authorization.helper';
import { IAiTool } from '../../src/core/modules/ai/interfaces/ai-tool.interface';
import { CoreAiAgentFunctionBridge } from '../../src/core/modules/ai/services/core-ai-agent-function.bridge';
import { AiToolRegistry } from '../../src/core/modules/ai/tools/ai-tool.registry';
import { RolesGuard } from '../../src/core/modules/auth/guards/roles.guard';

function user(id: string, roles: string[]) {
  return {
    _authenticatedViaBetterAuth: true,
    hasRole(required: string[]) {
      return required.some((role) => this.roles.includes(role));
    },
    id,
    roles,
  };
}

describe('Standard Schema parameters of an AI tool', () => {
  const execute = vi.fn(async (args: Record<string, any>) => ({ data: args, success: true }));
  const authorize = vi.fn(async () => true);
  const tool: IAiTool = {
    authorize,
    description: 'Book a room',
    execute,
    name: 'book_room',
    parameters: z.object({ nights: z.coerce.number().int().min(1), room: z.string() }) as any,
    roles: [RoleEnum.S_USER],
  };

  it('is stored as JSON Schema, for the model, the prompt catalog and MCP tools/list', () => {
    const registry = new AiToolRegistry();
    registry.register(tool);
    const stored = registry.get('book_room');
    expect(stored.parameters.type).toBe('object');
    expect(Object.keys(stored.parameters.properties)).toEqual(['nights', 'room']);
    expect(stored.name).toBe('book_room');
    expect(stored.roles).toEqual([RoleEnum.S_USER]);
  });

  /**
   * @regression   12.10.0 — a tool declared with a Standard Schema must never run on arguments the schema refuses;
   *   the model writes them, and a tool written against the schema's type trusts them.
   * @seen-failing Skip the validation in the execute wrapper of withStandardSchemaParameters() in
   *   src/core/modules/ai/tools/ai-tool-schema.helper.ts — registered as mutation `ai-tool-standard-schema-unvalidated`
   *   in tests/regression-mutations.json.
   */
  it('validates the arguments before authorize() and execute()', async () => {
    const registry = new AiToolRegistry();
    registry.register(tool);
    const stored = registry.get('book_room');
    const context = { serviceOptions: {} };

    execute.mockClear();
    await expect(stored.execute({ nights: 0, room: 'A' }, context)).resolves.toMatchObject({
      message: expect.stringContaining('nights'),
      success: false,
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(authorizeToolCall(stored, { room: 7 }, context)).resolves.toMatchObject({ allowed: false });
    expect(authorize).not.toHaveBeenCalled();

    await expect(stored.execute({ nights: '2', room: 'A' }, context)).resolves.toEqual({
      data: { nights: 2, room: 'A' },
      success: true,
    });
    expect(execute).toHaveBeenCalledWith({ nights: 2, room: 'A' }, context);
  });

  it('refuses a schema that cannot produce JSON Schema at registration', () => {
    const registry = new AiToolRegistry();
    const opaque = { '~standard': { validate: () => ({ value: {} }), vendor: 'opaque', version: 1 } };
    expect(() => registry.register({ ...tool, name: 'opaque', parameters: opaque as any })).toThrow(/JSON Schema/);
  });
});

@Injectable()
class BookingTools {
  @AgentFunction({ description: 'Cancel a booking', inputSchema: z.object({ id: z.string() }), name: 'cancel_booking' })
  @AiAgentFunction({ destructive: true })
  @Roles(RoleEnum.ADMIN)
  cancel({ id }: { id: string }) {
    return { cancelled: id };
  }

  @AgentFunction({ description: 'List bookings', name: 'list_bookings' })
  list() {
    return [{ id: 'b1' }];
  }

  @AgentFunction({ description: 'Export', name: 'export_bookings', scopes: ['bookings:export'] })
  export() {
    return [];
  }

  @AgentFunction({ description: 'Notes', name: 'booking_note' })
  @AiAgentFunction({
    authorize(args: Record<string, any>) {
      return { allowed: args.id === 'allowed', reason: 'Only the allowed booking' };
    },
    roles: [RoleEnum.S_USER],
  })
  note() {
    return { ok: true };
  }
}

describe('ai.agentFunctions bridge', () => {
  let app: INestApplication;
  let registry: AiToolRegistry;

  beforeAll(async () => {
    new ConfigService({ ai: { agentFunctions: { exclude: ['booking_ignored'] } } } as any, { reInit: true });
    @Module({
      imports: [AiModule.forRoot({ models: { default: new FakeModel() } })],
      providers: [
        AiToolRegistry,
        BookingTools,
        CoreAiAgentFunctionBridge,
        Reflector,
        RolesGuard,
        { provide: APP_GUARD, useExisting: RolesGuard },
      ],
    })
    class BridgeModule {}
    const moduleRef = await Test.createTestingModule({ imports: [BridgeModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    registry = app.get(AiToolRegistry);
  });

  afterAll(async () => {
    await app?.close();
    new ConfigService({} as any, { reInit: true });
  });

  /**
   * @regression   12.10.0 — an agent function without `@Roles()` or `@AiAgentFunction({ roles })` is offered to signed-in
   *   users only, never to everybody: the registry role filter is the first gate, and an open default would hand every
   *   undecorated agent function to an anonymous MCP or chat caller.
   * @seen-failing Default the roles to `S_EVERYONE` instead of `S_USER` in CoreAiAgentFunctionBridge.toTool() in
   *   src/core/modules/ai/services/core-ai-agent-function.bridge.ts — registered as mutation
   *   `ai-agent-function-default-roles-open` in tests/regression-mutations.json.
   */
  it('offers agent functions with the framework extras, roles from @Roles() or S_USER', () => {
    expect(registry.get('cancel_booking')).toMatchObject({ destructive: true, mutating: true, roles: [RoleEnum.ADMIN] });
    expect(registry.get('cancel_booking').parameters.properties.id).toBeDefined();
    expect(registry.get('list_bookings')).toMatchObject({ destructive: false, roles: [RoleEnum.S_USER] });
    expect(registry.forUser(undefined).map((tool) => tool.name)).not.toContain('list_bookings');
    expect(registry.forUser(user('m1', [])).map((tool) => tool.name)).not.toContain('cancel_booking');
    expect(registry.forUser(user('a1', [RoleEnum.ADMIN])).map((tool) => tool.name)).toContain('cancel_booking');
  });

  it('does not offer an agent function that requires scopes', () => {
    expect(registry.get('export_bookings')).toBeUndefined();
  });

  it('runs authorize() from @AiAgentFunction() before anything executes', async () => {
    const tool = registry.get('booking_note');
    const context = { serviceOptions: {} };
    await expect(authorizeToolCall(tool, { id: 'other' }, context)).resolves.toMatchObject({ allowed: false });
    await expect(authorizeToolCall(tool, { id: 'allowed' }, context)).resolves.toMatchObject({ allowed: true });
  });

  it("executes through @nestjs/ai with the run's request, so the application's guards decide on its user", async () => {
    const tool = registry.get('cancel_booking');
    const run = (request: unknown) =>
      RequestContext.run({ request } as any, () => tool.execute({ id: 'B-1' }, { serviceOptions: {} }));

    await expect(run({ headers: {}, user: user('a1', [RoleEnum.ADMIN]) })).resolves.toEqual({ cancelled: 'B-1' });
    await expect(run({ headers: {}, user: user('m1', []) })).rejects.toThrow(/LTNS_0101/);
    // No request (a run outside HTTP): anonymous to the guards
    await expect(tool.execute({ id: 'B-1' }, { serviceOptions: {} })).rejects.toThrow(/LTNS_0100/);
    // Arguments the agent function's schema refuses never reach it
    await expect(
      RequestContext.run({ request: { headers: {}, user: user('a1', [RoleEnum.ADMIN]) } } as any, () =>
        tool.execute({ id: 7 } as any, { serviceOptions: {} }),
      ),
    ).resolves.toMatchObject({ success: false });
  });

  it('stops the boot when an agent function is named like a registered tool', async () => {
    const bridge = app.get(CoreAiAgentFunctionBridge);
    await expect(bridge.onApplicationBootstrap()).rejects.toThrow(/has the name of a registered AI tool/);
  });
});

describe('secret fields in tool results', () => {
  const leaky: IAiTool = {
    description: 'Leaks',
    async execute() {
      return {
        data: [{ apiKeyEncrypted: 'enc', email: 'a@b.c', nested: { password_reset_token: 'tok', password: 'hash' } }],
        success: true,
      };
    },
    name: 'leaky_lookup',
    parameters: { properties: {}, type: 'object' },
    roles: [RoleEnum.S_USER],
  };

  /**
   * @regression   12.10.0 — the MCP server sent `JSON.stringify(result)` of a tool to the client, and the chat loop ran
   *   `securityCheck()` on model instances only: a tool returning a lean document or a plain object handed its
   *   password hash, reset token or encrypted API key to the model and the MCP client.
   * @seen-failing Return `applySecurityChecks(value, user)` without stripSecretFieldsForModel() in
   *   sanitizeToolResultForModel() in src/core/modules/ai/tools/ai-tool-result.helper.ts — registered as mutation
   *   `ai-tool-result-secrets-kept` in tests/regression-mutations.json.
   */
  it('never reach the MCP client or the model, in any shape', async () => {
    const registry = new AiToolRegistry();
    registry.register(leaky);
    const { CoreAiMcpService } = await import('../../src/core/modules/ai/services/core-ai-mcp.service');
    const result = await new CoreAiMcpService(registry).mcpCallTool({ id: 'u1', roles: [] }, 'leaky_lookup', {});
    const text = result.content[0].text;
    expect(text).toContain('a@b.c');
    expect(text).not.toMatch(/hash|tok|enc"/);

    const { sanitizeToolResultForModel } = await import('../../src/core/modules/ai/tools/ai-tool-result.helper');
    const original = await leaky.execute({}, { serviceOptions: {} });
    const sanitized = JSON.stringify(sanitizeToolResultForModel(original, undefined));
    expect(sanitized).not.toMatch(/"password"|password_reset_token|apiKeyEncrypted/);
    // The tool's own value is not mutated
    expect(JSON.stringify(original)).toContain('password_reset_token');
  });
});

describe('tool results through the chat loop and MCP', () => {
  class Contract {
    owner?: string;
    secretTerms?: string;

    securityCheck(viewer: any) {
      if (!viewer?.hasRole?.([RoleEnum.ADMIN])) {
        this.secretTerms = undefined;
      }
      return this;
    }
  }
  const contract = () => Object.assign(new Contract(), { owner: 'o1', secretTerms: 'terms' });

  /**
   * @regression   12.10.0 — the chat loop's `sanitizeResult()` ran securityCheck() only, so a plain or lean tool result
   *   reached the model provider and `actions[].result` with its password hash, reset token or encrypted API key.
   * @seen-failing Restore the old body of CoreAiService.sanitizeResult() (securityCheck() only) in
   *   src/core/modules/ai/services/core-ai.service.ts — registered as mutation `ai-chat-tool-result-secrets-kept` in
   *   tests/regression-mutations.json.
   */
  it('the chat loop removes secret fields and applies securityCheck()', async () => {
    const { CoreAiService } = await import('../../src/core/modules/ai/services/core-ai.service');
    const sanitize = (value: unknown, current: unknown) =>
      (CoreAiService.prototype as any).sanitizeResult.call({}, value, current);
    const result = JSON.stringify(sanitize({ items: [{ email: 'a@b.c', password: 'hash' }], contract: contract() }, null));
    expect(result).toContain('a@b.c');
    expect(result).not.toMatch(/hash|terms/);
  });

  /**
   * @regression   12.10.0 — a hydrated Mongoose document was kept "opaque", and JSON.stringify then wrote its toJSON()
   *   — every stored field, the password hash included — into the model's context and the MCP answer.
   * @seen-failing Treat an object with `$__` as opaque again in isOpaque() in
   *   src/core/modules/ai/tools/ai-tool-result.helper.ts — registered as mutation `ai-tool-result-mongoose-document-kept`
   *   in tests/regression-mutations.json.
   */
  it('strips secrets from a hydrated Mongoose document', async () => {
    const { default: mongoose } = await import('mongoose');
    const schema = new mongoose.Schema({ email: String, password: String, passwordResetToken: String });
    const Model = mongoose.models.AiLeakDoc ?? mongoose.model('AiLeakDoc', schema);
    const doc = Model.hydrate({ email: 'a@b.c', password: 'hash', passwordResetToken: 'tok' });
    const { sanitizeToolResultForModel } = await import('../../src/core/modules/ai/tools/ai-tool-result.helper');
    const result = JSON.stringify(sanitizeToolResultForModel({ user: doc }, null));
    expect(result).toContain('a@b.c');
    expect(result).not.toMatch(/hash|"tok"/);
  });

  /**
   * @regression   12.10.0 — MCP `tools/call` sent `{ success, data }` (the documented result shape) without running
   *   securityCheck() on the model instances inside `data`; what securityCheck() hides reached the MCP client. An MCP
   *   OAuth user had no `hasRole()`, so a securityCheck() calling it threw.
   * @seen-failing Stop applySecurityChecks() in src/core/modules/ai/tools/ai-tool-result.helper.ts from walking plain
   *   objects — registered as mutation `ai-tool-result-wrapper-unchecked` in tests/regression-mutations.json.
   */
  it('MCP applies securityCheck() inside the { success, data } wrapper, for an MCP OAuth user too', async () => {
    const registry = new AiToolRegistry();
    registry.register({
      description: 'Contract',
      async execute() {
        return { data: [contract()], success: true };
      },
      name: 'get_contract',
      parameters: { properties: {}, type: 'object' },
      roles: [RoleEnum.S_USER],
    });
    const { CoreAiMcpService } = await import('../../src/core/modules/ai/services/core-ai-mcp.service');
    const { toVerifiedAiUser } = await import('../../src/core/modules/ai/helpers/ai-verified-user.helper');
    const service = new CoreAiMcpService(registry);

    const member = await service.mcpCallTool(toVerifiedAiUser({ id: 'u1', roles: [] }), 'get_contract', {});
    expect(member.isError).toBeFalsy();
    expect(member.content[0].text).toContain('o1');
    expect(member.content[0].text).not.toContain('terms');

    const admin = await service.mcpCallTool(toVerifiedAiUser({ id: 'a1', roles: ['admin'] }), 'get_contract', {});
    expect(admin.content[0].text).toContain('terms');
  });
});

describe('MCP OAuth users on bridged agent functions', () => {
  let app: INestApplication;

  beforeAll(async () => {
    new ConfigService({ ai: { agentFunctions: { include: ['cancel_booking'] } } } as any, { reInit: true });
    @Module({
      imports: [AiModule.forRoot({ models: { default: new FakeModel() } })],
      providers: [
        AiToolRegistry,
        BookingTools,
        CoreAiAgentFunctionBridge,
        Reflector,
        RolesGuard,
        { provide: APP_GUARD, useExisting: RolesGuard },
      ],
    })
    class OAuthBridgeModule {}
    const moduleRef = await Test.createTestingModule({ imports: [OAuthBridgeModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    new ConfigService({} as any, { reInit: true });
  });

  /**
   * @regression   12.10.0 — `/ai/mcp` put an MCP OAuth token's user on the request as `loadUser()`'s plain
   *   `{ id, roles }`. RolesGuard (three-argument CoreModule.forRoot()) decides on an existing user only when it carries
   *   `_authenticatedViaBetterAuth`, so every role-gated agent function answered 401 to every OAuth user.
   * @seen-failing Return `this.oauthService.loadUser(payload.sub)` without toVerifiedAiUser() in
   *   CoreAiMcpController.resolveUser() in src/core/modules/ai/core-ai-mcp.controller.ts — registered as mutation
   *   `mcp-oauth-user-unmarked` in tests/regression-mutations.json.
   */
  it('the user /ai/mcp resolves from an OAuth token passes the role guard of a bridged agent function', async () => {
    const { CoreAiMcpController } = await import('../../src/core/modules/ai/core-ai-mcp.controller');
    const oauth = {
      acceptsAudienceAtMcp: () => true,
      loadUser: async (id: string) => ({ id, roles: [RoleEnum.ADMIN] }),
      verifyAccessToken: () => ({ cid: 'c1', exp: 9_999_999_999, sub: 'admin-1', type: 'mcp_access' }),
    };
    const controller = new CoreAiMcpController({} as any, oauth as any);
    (controller as any).oauthEnabled = () => true;
    const req: any = { headers: { authorization: 'Bearer oauth-token' } };
    const resolved = await (controller as any).resolveUser(req);
    req.user = resolved;

    const tool = app.get(AiToolRegistry).get('cancel_booking');
    await expect(
      RequestContext.run({ request: req } as any, () => tool.execute({ id: 'B-9' }, { serviceOptions: {} })),
    ).resolves.toEqual({ cancelled: 'B-9' });
  });
});
