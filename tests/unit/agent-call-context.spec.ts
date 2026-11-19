/**
 * Our GLOBAL guards, interceptors and filters on agent function calls (`@nestjs/ai`, context type `'ai'`) and MCP
 * tool calls (`@nestjs/mcp`, `'mcp'`). nestjs-ai plan §1.
 *
 * Both packages run every global enhancer of the application around their methods, with the arguments
 * `[input, call]`. Index 0 is what the MODEL (or the MCP client) wrote; the HTTP fallback our guards used returned
 * exactly that as "the request". These cases run the REAL pipelines of both packages (`@nestjs/ai`'s `callTool()`,
 * `@nestjs/mcp`'s registry handler) with the framework's real guards, interceptors and filter registered globally.
 */
import { ForbiddenException, INestApplication, Injectable, Module, Type, UseGuards } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { Test } from '@nestjs/testing';
import { AgentFunction, AiModule } from '@nestjs/ai';
import { callTool, FakeModel } from '@nestjs/ai/testing';
import { McpModule, McpRegistry, Tool } from '@nestjs/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CurrentUser } from '../../src/core/common/decorators/current-user.decorator';
import { Restricted } from '../../src/core/common/decorators/restricted.decorator';
import { RESTUser } from '../../src/core/common/decorators/rest-user.decorator';
import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { HttpExceptionLogFilter } from '../../src/core/common/filters/http-exception-log.filter';
import { MCP_VERIFIED_USER } from '../../src/core/common/helpers/execution-context-request.helper';
import { CheckResponseInterceptor } from '../../src/core/common/interceptors/check-response.interceptor';
import { CheckSecurityInterceptor } from '../../src/core/common/interceptors/check-security.interceptor';
import { ConfigService } from '../../src/core/common/services/config.service';
import { AuthGuardStrategy } from '../../src/core/modules/auth/auth-guard-strategy.enum';
import { AuthGuard } from '../../src/core/modules/auth/guards/auth.guard';
import { RolesGuard } from '../../src/core/modules/auth/guards/roles.guard';
import { BetterAuthRolesGuard } from '../../src/core/modules/better-auth/better-auth-roles.guard';
import { CoreTenantGuard } from '../../src/core/modules/tenant/core-tenant.guard';

const UNAUTHORIZED = /LTNS_0100/;
const ACCESS_DENIED = /LTNS_0101/;

/** A user as the authentication middleware leaves it on the request. */
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

/** What a tool call whose arguments impersonate an administrator looks like. */
const FORGED = { user: { _authenticatedViaBetterAuth: true, id: 'attacker', roles: [RoleEnum.ADMIN] } };

const loose = z.looseObject({});

/** A result with a field only administrators may read. */
class Note {
  @Restricted(RoleEnum.ADMIN)
  internal?: string;

  title?: string;
}

@Injectable()
class AgentTools {
  @AgentFunction({ inputSchema: loose, name: 'admin_only' })
  @Roles(RoleEnum.ADMIN)
  adminOnly() {
    return { ok: true };
  }

  @AgentFunction({ inputSchema: loose, name: 'signed_in' })
  @Roles(RoleEnum.S_USER)
  signedIn() {
    return { ok: true };
  }

  @AgentFunction({ inputSchema: loose, name: 'open' })
  @Roles(RoleEnum.S_EVERYONE)
  open() {
    return { ok: true };
  }

  @AgentFunction({ inputSchema: loose, name: 'note' })
  @Roles(RoleEnum.S_EVERYONE)
  note() {
    return Object.assign(new Note(), { internal: 'admin-only', title: 'Visible' });
  }

  @AgentFunction({ inputSchema: loose, name: 'leaky' })
  @Roles(RoleEnum.S_USER)
  leaky() {
    return { email: 'a@b.c', nested: { passwordResetToken: 'reset-secret' }, password: 'hash-secret' };
  }

  @AgentFunction({ inputSchema: loose, name: 'refusing' })
  @Roles(RoleEnum.S_USER)
  refusing() {
    throw new ForbiddenException('Not for this ticket');
  }

  @AgentFunction({ inputSchema: loose, name: 'who_am_i' })
  @Roles(RoleEnum.S_EVERYONE)
  whoAmI(_input: unknown, _context: unknown, @CurrentUser() current: any, @RESTUser() rest: any) {
    return { current: current?.id ?? null, rest: rest?.id ?? null };
  }

  @AgentFunction({ inputSchema: loose, name: 'jwt_guarded' })
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  jwtGuarded() {
    return { ok: true };
  }

  @Tool({ inputSchema: loose, name: 'mcp_admin_only' })
  @Roles(RoleEnum.ADMIN)
  mcpAdminOnly() {
    return { content: [{ text: 'ok', type: 'text' }] };
  }
}

/** A class open to everybody whose method asks for a signed-in user: the method decides */
@Injectable()
@Roles(RoleEnum.S_EVERYONE)
class OpenClassTools {
  @AgentFunction({ inputSchema: loose, name: 'class_open_method_signed_in' })
  @Roles(RoleEnum.S_USER)
  signedIn() {
    return { ok: true };
  }
}

async function bootstrap(guard: Type<unknown>): Promise<INestApplication> {
  @Module({
    imports: [
      AiModule.forRoot({ models: { default: new FakeModel() } }),
      McpModule.forRoot({ name: 'agent-call-context', version: '0.0.0' }),
    ],
    providers: [
      AgentTools,
      OpenClassTools,
      { provide: ConfigService, useValue: new ConfigService({}, { reInit: true }) },
      Reflector,
      guard,
      { provide: APP_GUARD, useExisting: guard },
      { provide: APP_INTERCEPTOR, useClass: CheckResponseInterceptor },
      { provide: APP_INTERCEPTOR, useClass: CheckSecurityInterceptor },
      { provide: APP_FILTER, useClass: HttpExceptionLogFilter },
    ],
  })
  class AgentCallModule {}

  const moduleRef = await Test.createTestingModule({ imports: [AgentCallModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe.each([
  ['RolesGuard', RolesGuard],
  ['BetterAuthRolesGuard', BetterAuthRolesGuard],
])('agent and MCP calls through %s', (_name, guard) => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrap(guard);
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * @regression   12.10.0 — on an agent function call the guards read `switchToHttp().getRequest()`, which is the
   *   model's tool arguments. A model writing `{ user: { roles: ['admin'] } }` was the authenticated caller:
   *   BetterAuthRolesGuard granted `@Roles(ADMIN)`, RolesGuard granted `@Roles(S_USER)`.
   * @seen-failing Drop the agent-call branch from resolveGuardRequest() in
   *   src/core/common/helpers/execution-context-request.helper.ts — registered as mutation
   *   `agent-call-guard-reads-arguments` in tests/regression-mutations.json.
   */
  it('refuses a caller forged in the tool arguments (no request)', async () => {
    await expect(callTool(app, 'admin_only', FORGED)).rejects.toThrow(UNAUTHORIZED);
    await expect(callTool(app, 'signed_in', FORGED)).rejects.toThrow(UNAUTHORIZED);
  });

  it('refuses a caller forged in the tool arguments next to an anonymous request', async () => {
    const request = { headers: {} };
    await expect(callTool(app, 'signed_in', FORGED, { caller: { request } })).rejects.toThrow();
    await expect(callTool(app, 'admin_only', FORGED, { caller: { request } })).rejects.toThrow();
  });

  /**
   * @regression   12.10.0 (review) — the request-less branch tested the MERGED class and method roles for S_EVERYONE,
   *   so a class open to everybody opened its method that asks for S_USER, while HTTP lets the method decide.
   * @seen-failing Use the merged roles in RolesGuard's request-less agent branch in
   *   src/core/modules/auth/guards/roles.guard.ts — registered as mutation
   *   `agent-call-requestless-class-everyone-opens-roles-guard` in tests/regression-mutations.json.
   */
  it('lets the method roles decide for a request-less caller, not a class-level S_EVERYONE', async () => {
    await expect(callTool(app, 'class_open_method_signed_in', {})).rejects.toThrow(UNAUTHORIZED);
    const member = { headers: {}, user: user('member-1', []) };
    await expect(callTool(app, 'class_open_method_signed_in', {}, { caller: { request: member } })).resolves.toEqual({
      ok: true,
    });
  });

  it('treats a request-less caller as anonymous, whatever `caller.user` says', async () => {
    const caller = { user: user('job-user', [RoleEnum.ADMIN]) };
    await expect(callTool(app, 'admin_only', {}, { caller })).rejects.toThrow(UNAUTHORIZED);
    await expect(callTool(app, 'signed_in', {}, { caller })).rejects.toThrow(UNAUTHORIZED);
    await expect(callTool(app, 'open', {}, { caller })).resolves.toEqual({ ok: true });
  });

  it('decides against the user of the request the call runs in', async () => {
    const admin = { headers: {}, user: user('admin-1', [RoleEnum.ADMIN]) };
    const member = { headers: {}, user: user('member-1', []) };
    await expect(callTool(app, 'admin_only', FORGED, { caller: { request: admin } })).resolves.toEqual({ ok: true });
    await expect(callTool(app, 'signed_in', {}, { caller: { request: member } })).resolves.toEqual({ ok: true });
    await expect(callTool(app, 'admin_only', FORGED, { caller: { request: member } })).rejects.toThrow(ACCESS_DENIED);
  });

  it('strips secret fields from an agent function result before the model reads it', async () => {
    const member = { headers: {}, user: user('member-1', []) };
    const result = (await callTool(app, 'leaky', {}, { caller: { request: member } })) as Record<string, any>;
    expect(result.email).toBe('a@b.c');
    expect(JSON.stringify(result)).not.toContain('hash-secret');
    expect(JSON.stringify(result)).not.toContain('reset-secret');
  });

  /**
   * @regression   12.10.0 — the response interceptors took the current user from `switchToHttp().getRequest().user`,
   *   i.e. from the tool arguments: a model writing `{ user: { roles: ['admin'] } }` chose whose view of a result the
   *   `@Restricted` filtering applied.
   * @seen-failing Fall back to `context.getArgByIndex(0)?.user` in getContextData() in
   *   src/core/common/helpers/context.helper.ts — registered as mutation `agent-call-context-data-reads-arguments` in
   *   tests/regression-mutations.json.
   */
  it('filters a result for the request user, never for a user in the arguments', async () => {
    const anonymous = (await callTool(app, 'note', FORGED)) as Record<string, any>;
    expect(anonymous.title).toBe('Visible');
    expect(anonymous.internal).toBeUndefined();

    const admin = { headers: {}, user: user('admin-1', [RoleEnum.ADMIN]) };
    const visible = (await callTool(app, 'note', {}, { caller: { request: admin } })) as Record<string, any>;
    expect(visible.internal).toBe('admin-only');
  });

  /**
   * @regression   12.10.0 — HttpExceptionLogFilter wrote to `switchToHttp().getResponse()` on an agent call, which is
   *   the call object: the filter threw a TypeError and the model read "Internal server error" for every refusal.
   * @seen-failing Remove the `type !== 'http'` early return from HttpExceptionLogFilter.catch() in
   *   src/core/common/filters/http-exception-log.filter.ts — registered as mutation
   *   `http-exception-filter-writes-agent-response` in tests/regression-mutations.json.
   */
  it('hands an HttpException back to the model instead of writing an HTTP response', async () => {
    const member = { headers: {}, user: user('member-1', []) };
    await expect(callTool(app, 'refusing', {}, { caller: { request: member } })).rejects.toThrow('Not for this ticket');
  });

  /**
   * @regression   12.10.0 — `@CurrentUser()` and `@RESTUser()` read `switchToHttp().getRequest().user` on an agent call,
   *   i.e. a `user` the model wrote into the tool arguments — and handed it to the service as `currentUser`.
   * @seen-failing Drop the agent-call branch from currentUserDec() in src/core/common/helpers/decorator.helper.ts —
   *   registered as mutations `current-user-reads-agent-arguments` and (RESTUser) `rest-user-reads-agent-arguments` in
   *   tests/regression-mutations.json.
   */
  it('injects the request user into @CurrentUser() and @RESTUser(), never one from the arguments', async () => {
    const member = { headers: {}, user: user('member-1', []) };
    await expect(callTool(app, 'who_am_i', FORGED, { caller: { request: member } })).resolves.toEqual({
      current: 'member-1',
      rest: 'member-1',
    });
    await expect(callTool(app, 'who_am_i', FORGED)).resolves.toEqual({ current: null, rest: null });
  });

  /**
   * @regression   12.10.0 — the `AuthGuard()` mixin (`@UseGuards(AuthGuard(JWT))`) took the call's arguments as the
   *   request: a forged `{ user: { _authenticatedViaBetterAuth: true } }` passed it without any credential.
   * @seen-failing Drop the agent-call branch from MixinAuthGuard.getRequest() in
   *   src/core/modules/auth/guards/auth.guard.ts — registered as mutation `auth-guard-reads-agent-arguments` in
   *   tests/regression-mutations.json.
   */
  it('refuses a forged caller at @UseGuards(AuthGuard(JWT))', async () => {
    await expect(callTool(app, 'jwt_guarded', FORGED)).rejects.toThrow(UNAUTHORIZED);
  });

  describe('MCP tool calls', () => {
    function mcpCall(input: unknown, call: Record<string, unknown>) {
      const entry = app.get(McpRegistry).tools.find((tool) => tool.name === 'mcp_admin_only');
      return entry.handler(input, {
        kind: 'tool',
        name: 'mcp_admin_only',
        reportProgress: async () => undefined,
        server: {} as any,
        signal: new AbortController().signal,
        transport: 'http',
        era: 'modern',
        ...call,
      } as any);
    }

    it('refuses a caller forged in the MCP arguments', async () => {
      await expect(mcpCall(FORGED, {})).rejects.toThrow(UNAUTHORIZED);
    });

    it('decides against the request user', async () => {
      await expect(
        mcpCall(FORGED, { request: { headers: {}, user: user('admin-1', [RoleEnum.ADMIN]) } }),
      ).resolves.toBeDefined();
      await expect(mcpCall(FORGED, { request: { headers: {}, user: user('member-1', []) } })).rejects.toThrow(
        ACCESS_DENIED,
      );
    });

    /**
     * @regression   12.10.0 — the user of an MCP OAuth access token reaches a `@nestjs/mcp` tool's guards only through
     *   the framework's own verifier (`MCP_VERIFIED_USER`), never through a string key another verifier or a token
     *   claim could set.
     * @seen-failing Read `extra.user` instead of `extra[MCP_VERIFIED_USER]` in resolveAgentCallRequest() in
     *   src/core/common/helpers/execution-context-request.helper.ts — registered as mutation
     *   `mcp-verified-user-string-key` in tests/regression-mutations.json.
     */
    it('takes the verified user only from the framework verifier', async () => {
      const admin = user('admin-1', [RoleEnum.ADMIN]);
      await expect(
        mcpCall({}, { authInfo: { extra: { [MCP_VERIFIED_USER]: admin } }, request: { headers: {} } }),
      ).resolves.toBeDefined();
      await expect(mcpCall({}, { authInfo: { extra: { user: admin } }, request: { headers: {} } })).rejects.toThrow();
    });
  });
});

describe('CoreTenantGuard on agent and MCP calls', () => {
  const memberModel: any = {
    find: () => ({ select: () => ({ lean: () => ({ exec: async () => [] }) }) }),
    findOne: () => ({ lean: () => ({ exec: async () => null }) }),
  };
  let tenantGuard: CoreTenantGuard;

  class TenantTools {
    @Roles(RoleEnum.ADMIN)
    adminOnly() {}

    @Roles(RoleEnum.S_EVERYONE)
    open() {}
  }

  @Roles(RoleEnum.S_EVERYONE)
  class TenantOpenClassTools {
    @Roles(RoleEnum.S_USER)
    signedIn() {}
  }

  function agentContext(type: 'ai' | 'mcp', handler: () => void, call: Record<string, unknown>): ExecutionContextHost {
    const context = new ExecutionContextHost([FORGED, { name: handler.name, ...call }], TenantTools, handler);
    context.setType(type);
    return context;
  }

  beforeAll(() => {
    ConfigService.setConfig({ env: 'local', multiTenancy: { cacheTtlMs: 0 } } as any, { reInit: true, warn: false });
    tenantGuard = new CoreTenantGuard(new Reflector(), memberModel);
  });

  afterAll(() => {
    tenantGuard.onModuleDestroy();
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });

  /**
   * @regression   12.10.0 — CoreTenantGuard answered "no request" with `return true`. On a request-less agent call
   *   (`caller: { user }`, a durable run, MCP over stdio) the role guards delegate non-system roles to it, so a missing
   *   request must refuse a role-gated method rather than grant it.
   * @seen-failing Drop the agent-call branch under `if (!request)` in CoreTenantGuard.canActivate() in
   *   src/core/modules/tenant/core-tenant.guard.ts — registered as mutation `tenant-guard-requestless-agent-grants` in
   *   tests/regression-mutations.json.
   */
  it.each(['ai', 'mcp'] as const)('refuses a request-less %s call on a role-gated method', async (type) => {
    const proto = TenantTools.prototype;
    await expect(
      Promise.resolve(tenantGuard.canActivate(agentContext(type, proto.adminOnly, { user: user('job', ['admin']) }))),
    ).rejects.toThrow(UNAUTHORIZED);
    await expect(Promise.resolve(tenantGuard.canActivate(agentContext(type, proto.open, {})))).resolves.toBe(true);
  });

  /**
   * @regression   12.10.0 (review) — with multiTenancy, a class-level S_EVERYONE opened a method that asks for S_USER
   *   to a request-less agent call; the HTTP path lets the method's own roles decide (`systemCheckRoles`).
   * @seen-failing Use the merged roles in CoreTenantGuard's request-less agent branch in
   *   src/core/modules/tenant/core-tenant.guard.ts — registered as mutation
   *   `agent-call-requestless-class-everyone-opens-tenant-guard` in tests/regression-mutations.json.
   */
  it('lets the method roles decide for a request-less call, not a class-level S_EVERYONE', async () => {
    const context = new ExecutionContextHost(
      [FORGED, { name: 'signedIn' }],
      TenantOpenClassTools,
      TenantOpenClassTools.prototype.signedIn,
    );
    context.setType('ai');
    await expect(Promise.resolve(tenantGuard.canActivate(context))).rejects.toThrow(UNAUTHORIZED);
  });
});
