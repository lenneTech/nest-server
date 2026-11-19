/**
 * The framework's global guards, interceptors, decorators and filter on agent function calls (`@nestjs/ai`, context
 * type `'ai'`) and MCP tool calls (`@nestjs/mcp`, `'mcp'`). nestjs-ai plan §1, backported to the 12.6.x line.
 *
 * Both packages run every global enhancer of an application around their methods, with the arguments `[input, call]`.
 * Index 0 is what the MODEL (or the MCP client) wrote; the HTTP fallback the guards used returned exactly that as "the
 * request". These cases build such contexts directly, so the maintenance line needs neither package to prove it.
 */
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RESTUser } from '../../src/core/common/decorators/rest-user.decorator';
import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { HttpExceptionLogFilter } from '../../src/core/common/filters/http-exception-log.filter';
import { getContextData } from '../../src/core/common/helpers/context.helper';
import { currentUserDec } from '../../src/core/common/helpers/decorator.helper';
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

/** Tool arguments that impersonate an administrator, as a model or MCP client could write them. */
const FORGED = {
  headers: {},
  user: { _authenticatedViaBetterAuth: true, id: 'attacker', roles: [RoleEnum.ADMIN] },
};

class AgentTools {
  @Roles(RoleEnum.ADMIN)
  adminOnly() {}

  @Roles(RoleEnum.S_USER)
  signedIn() {}

  @Roles(RoleEnum.S_EVERYONE)
  open() {}
}

/** The execution context `@nestjs/ai` (`'ai'`) / `@nestjs/mcp` (`'mcp'`) hands the enhancers: `[input, call]`. */
function agentContext(
  type: 'ai' | 'mcp',
  handler: () => void,
  call: Record<string, unknown> = {},
  input: unknown = FORGED,
): ExecutionContextHost {
  const context = new ExecutionContextHost([input, { name: handler.name, ...call }], AgentTools, handler);
  context.setType(type);
  return context;
}

const proto = AgentTools.prototype;

/** A class open to everybody whose method asks for a signed-in user: the method decides */
@Roles(RoleEnum.S_EVERYONE)
class OpenClassTools {
  @Roles(RoleEnum.S_USER)
  signedIn() {}
}

function openClassContext(type: 'ai' | 'mcp'): ExecutionContextHost {
  const context = new ExecutionContextHost(
    [FORGED, { name: 'signedIn' }],
    OpenClassTools,
    OpenClassTools.prototype.signedIn,
  );
  context.setType(type);
  return context;
}

async function outcome(run: () => boolean | Promise<boolean>): Promise<string> {
  try {
    return (await run()) ? 'granted' : 'refused';
  } catch (error) {
    return (error as Error).message;
  }
}

describe.each([
  ['RolesGuard', () => new RolesGuard(new Reflector())],
  ['BetterAuthRolesGuard', () => new BetterAuthRolesGuard()],
])('%s on agent and MCP calls', (_name, makeGuard) => {
  /**
   * @regression   12.6.x backport of 12.10.0 — on an agent function / MCP call the guards read
   *   `switchToHttp().getRequest()`, which is the model's tool arguments: `{ user: { roles: ['admin'] } }` there was
   *   the authenticated caller (BetterAuthRolesGuard granted `@Roles(ADMIN)`, RolesGuard `@Roles(S_USER)`).
   * @seen-failing Drop the agent-call branch from resolveGuardRequest() in
   *   src/core/common/helpers/execution-context-request.helper.ts — registered as mutation
   *   `agent-call-guard-reads-arguments` in tests/regression-mutations.json.
   */
  it.each(['ai', 'mcp'] as const)('refuses a caller forged in the %s call arguments', async (type) => {
    const guard = makeGuard();
    await expect(outcome(() => guard.canActivate(agentContext(type, proto.adminOnly)))).resolves.toMatch(UNAUTHORIZED);
    await expect(outcome(() => guard.canActivate(agentContext(type, proto.signedIn)))).resolves.toMatch(UNAUTHORIZED);
    await expect(outcome(() => guard.canActivate(agentContext(type, proto.open)))).resolves.toBe('granted');
  });

  it('decides against the user of the request the call runs in', async () => {
    const guard = makeGuard();
    const admin = { headers: {}, user: user('admin-1', [RoleEnum.ADMIN]) };
    const member = { headers: {}, user: user('member-1', []) };
    await expect(outcome(() => guard.canActivate(agentContext('ai', proto.adminOnly, { request: admin })))).resolves.toBe(
      'granted',
    );
    await expect(
      outcome(() => guard.canActivate(agentContext('mcp', proto.signedIn, { request: member }))),
    ).resolves.toBe('granted');
    await expect(
      outcome(() => guard.canActivate(agentContext('ai', proto.adminOnly, { request: member }))),
    ).resolves.toMatch(ACCESS_DENIED);
  });

  /**
   * @regression   12.6.x backport of 12.10.0 (review) — the request-less branch tested the MERGED class and method
   *   roles for S_EVERYONE, so a class open to everybody opened its method that asks for S_USER.
   * @seen-failing Use the merged roles in RolesGuard's request-less agent branch in
   *   src/core/modules/auth/guards/roles.guard.ts — registered as mutation
   *   `agent-call-requestless-class-everyone-opens-roles-guard` in tests/regression-mutations.json.
   */
  it('lets the method roles decide for a request-less caller, not a class-level S_EVERYONE', async () => {
    const guard = makeGuard();
    await expect(outcome(() => guard.canActivate(openClassContext('ai')))).resolves.toMatch(UNAUTHORIZED);
  });

  it('treats a request-less caller as anonymous, whatever caller.user says', async () => {
    const guard = makeGuard();
    const context = agentContext('ai', proto.adminOnly, { user: user('job', [RoleEnum.ADMIN]) }, {});
    await expect(outcome(() => guard.canActivate(context))).resolves.toMatch(UNAUTHORIZED);
  });
});

describe('AuthGuard() on agent calls', () => {
  /**
   * @regression   12.6.x backport of 12.10.0 — the AuthGuard() mixin took an agent call's arguments as the request:
   *   a forged `{ user: { _authenticatedViaBetterAuth: true } }` passed `@UseGuards(AuthGuard(JWT))` without a
   *   credential.
   * @seen-failing Drop the agent-call branch from MixinAuthGuard.getRequest() in
   *   src/core/modules/auth/guards/auth.guard.ts — registered as mutation `auth-guard-reads-agent-arguments` in
   *   tests/regression-mutations.json.
   */
  it('refuses a forged caller', async () => {
    const Guard = AuthGuard(AuthGuardStrategy.JWT);
    const guard = new (Guard as any)();
    await expect(outcome(() => guard.canActivate(agentContext('ai', proto.signedIn)))).resolves.toMatch(UNAUTHORIZED);
  });
});

describe('the current user of an agent call', () => {
  /**
   * @regression   12.6.x backport of 12.10.0 — `@CurrentUser()`, `@RESTUser()` and the response interceptors
   *   (getContextData()) read the user from the tool arguments: a model chose who the service saw as `currentUser`
   *   and whose view of the result the `@Restricted` filtering applied.
   * @seen-failing Fall back to `context.getArgByIndex(0)?.user` in getContextData() in
   *   src/core/common/helpers/context.helper.ts — registered as mutation `agent-call-context-data-reads-arguments` in
   *   tests/regression-mutations.json; the decorator branches are mutations `current-user-reads-agent-arguments` and
   *   `rest-user-reads-agent-arguments`.
   */
  it('is the request user, never one from the arguments', () => {
    const member = { headers: {}, user: user('member-1', []) };
    const withRequest = agentContext('ai', proto.open, { request: member });
    const requestLess = agentContext('mcp', proto.open);

    expect(getContextData(withRequest).currentUser?.id).toBe('member-1');
    expect(getContextData(requestLess).currentUser).toBeUndefined();
    expect(currentUserDec(undefined, withRequest)?.id).toBe('member-1');
    expect(currentUserDec(undefined, requestLess)).toBeUndefined();

    class Probe {
      handler(@RESTUser() _user: unknown) {}
    }
    const metadata = Reflect.getMetadata('__routeArguments__', Probe, 'handler') ?? {};
    const factory = (Object.values(metadata)[0] as { factory: (data: unknown, ctx: unknown) => any }).factory;
    expect(factory(undefined, withRequest)?.id).toBe('member-1');
    expect(factory(undefined, requestLess)).toBeUndefined();
  });
});

describe('HttpExceptionLogFilter on agent calls', () => {
  /**
   * @regression   12.6.x backport of 12.10.0 — the filter wrote every HttpException to `switchToHttp().getResponse()`,
   *   which on an agent call is the call object: it threw a TypeError, and the model read "Internal server error"
   *   for every refusal.
   * @seen-failing Remove the isAgentCallContext() early return from HttpExceptionLogFilter.catch() in
   *   src/core/common/filters/http-exception-log.filter.ts — registered as mutation
   *   `http-exception-filter-writes-agent-response` in tests/regression-mutations.json.
   */
  it('hands the exception back instead of writing an HTTP response', () => {
    const filter = new HttpExceptionLogFilter();
    expect(() => filter.catch(new ForbiddenException('Not for this ticket'), agentContext('ai', proto.open))).not.toThrow();
    expect(filter.catch(new ForbiddenException('x'), agentContext('mcp', proto.open))).toBeUndefined();
  });
});

describe('CoreTenantGuard on agent calls', () => {
  const memberModel: any = {
    find: () => ({ select: () => ({ lean: () => ({ exec: async () => [] }) }) }),
    findOne: () => ({ lean: () => ({ exec: async () => null }) }),
  };
  let tenantGuard: CoreTenantGuard;

  beforeAll(() => {
    ConfigService.setConfig({ env: 'local', multiTenancy: { cacheTtlMs: 0 } } as any, { reInit: true, warn: false });
    tenantGuard = new CoreTenantGuard(new Reflector(), memberModel);
  });

  afterAll(() => {
    tenantGuard.onModuleDestroy();
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });

  /**
   * @regression   12.6.x backport of 12.10.0 — CoreTenantGuard answered "no request" with `return true`; on a
   *   request-less agent call the role guards delegate non-system roles to it, so a missing request must refuse.
   * @seen-failing Drop the agent-call branch under `if (!request)` in CoreTenantGuard.canActivate() in
   *   src/core/modules/tenant/core-tenant.guard.ts — registered as mutation `tenant-guard-requestless-agent-grants` in
   *   tests/regression-mutations.json.
   */
  it.each(['ai', 'mcp'] as const)('refuses a request-less %s call on a role-gated method', async (type) => {
    await expect(
      outcome(() => tenantGuard.canActivate(agentContext(type, proto.adminOnly, { user: user('job', ['admin']) }))),
    ).resolves.toMatch(UNAUTHORIZED);
    await expect(outcome(() => tenantGuard.canActivate(agentContext(type, proto.open)))).resolves.toBe('granted');
  });

  /**
   * @regression   12.6.x backport of 12.10.0 (review) — with multiTenancy, a class-level S_EVERYONE opened a method
   *   that asks for S_USER to a request-less agent call; the HTTP path lets the method's own roles decide.
   * @seen-failing Use the merged roles in CoreTenantGuard's request-less agent branch in
   *   src/core/modules/tenant/core-tenant.guard.ts — registered as mutation
   *   `agent-call-requestless-class-everyone-opens-tenant-guard` in tests/regression-mutations.json.
   */
  it('lets the method roles decide for a request-less call, not a class-level S_EVERYONE', async () => {
    await expect(outcome(() => tenantGuard.canActivate(openClassContext('mcp')))).resolves.toMatch(UNAUTHORIZED);
  });
});
