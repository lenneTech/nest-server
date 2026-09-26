/**
 * Invariants that keep API tokens safe against FUTURE changes, not just today's wiring.
 *
 * 1. Every guard enforces the token policy ON ITS OWN. The three guards run in an order the framework
 *    does not promise, a project can replace one (`CoreTenantModule.forRoot({ guard })`), and a guard
 *    refactor can move the public-route shortcut. If any single guard stopped refusing tokens, a public
 *    or unreleased route would open to them the moment that guard happened to decide alone. So each
 *    guard is exercised standalone here, with no middleware and no other guard around it.
 *
 * 2. The MCP OAuth consent step refuses token-authenticated requests. It is an Express router outside
 *    the Nest guards, so the deny-by-default of @ApiTokenScopes() cannot reach it — and a consent mints
 *    an access token with the user's FULL rights.
 */
import { Controller, ExecutionContext, ForbiddenException, Get, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { ApiTokenKind } from '../../src/core/modules/api-token/core-api-token.constants';
import { ApiTokenScopes } from '../../src/core/modules/api-token/core-api-token.decorators';
import {
  attachApiTokenContext,
  createTenantApiTokenPrincipal,
  generateApiToken,
} from '../../src/core/modules/api-token/core-api-token.helpers';
import { CoreAiMcpOAuthService } from '../../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { RolesGuard } from '../../src/core/modules/auth/guards/roles.guard';
import { BetterAuthRolesGuard } from '../../src/core/modules/better-auth/better-auth-roles.guard';
import { CoreTenantGuard } from '../../src/core/modules/tenant/core-tenant.guard';

@Controller('probe')
class Probe {
  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  publicRoute() {}

  @Get('undecorated')
  undecorated() {}

  @Get('protected')
  @Roles(RoleEnum.S_USER)
  protectedRoute() {}

  @ApiTokenScopes('read')
  @Get('released')
  @Roles(RoleEnum.S_USER)
  released() {}

  @ApiTokenScopes('read')
  @Get('released-self/:id')
  @Roles(RoleEnum.S_SELF)
  releasedSelf() {}
}

function httpContext(handler: any, request: any): ExecutionContext {
  const args = [request, {}, () => undefined];
  return {
    getArgByIndex: (index: number) => args[index],
    getArgs: () => args,
    getClass: () => Probe,
    getHandler: () => handler,
    getType: () => 'http',
    switchToHttp: () => ({ getNext: () => args[2], getRequest: () => request, getResponse: () => args[1] }),
  } as unknown as ExecutionContext;
}

const tenantPrincipal = () =>
  createTenantApiTokenPrincipal({
    name: 'erp',
    publicId: 'a'.repeat(24),
    scopes: ['read'],
    tenantId: 'tenant-a',
    tokenId: '65f000000000000000000001',
  });

const userWithToken = () =>
  attachApiTokenContext(
    { hasRole: () => false, id: '65f000000000000000000009', roles: [] },
    {
      kind: ApiTokenKind.USER,
      name: 'cli',
      publicId: 'b'.repeat(24),
      scopes: ['read'],
      tokenId: '65f000000000000000000002',
      userId: '65f000000000000000000009',
    },
  );

describe('API token invariants — every guard enforces the policy on its own', () => {
  const memberModel: any = {
    find: () => ({ select: () => ({ lean: () => ({ exec: async () => [] }) }) }),
    findOne: () => ({ lean: () => ({ exec: async () => null }) }),
  };
  let tenantGuard: CoreTenantGuard;

  beforeAll(() => {
    ConfigService.setConfig({ apiTokens: { scopes: ['read'] }, env: 'local', multiTenancy: { cacheTtlMs: 0 } } as any, {
      reInit: true,
      warn: false,
    });
    tenantGuard = new CoreTenantGuard(new Reflector(), memberModel);
  });

  afterAll(() => {
    tenantGuard.onModuleDestroy();
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });

  const guards: Array<[string, () => { canActivate: (context: ExecutionContext) => Promise<boolean> | boolean }]> = [
    ['RolesGuard (legacy)', () => new RolesGuard(new Reflector())],
    ['BetterAuthRolesGuard (IAM)', () => new BetterAuthRolesGuard()],
    ['CoreTenantGuard', () => tenantGuard],
  ];

  describe.each(guards)('%s', (_name, makeGuard) => {
    it.each(['publicRoute', 'undecorated', 'protectedRoute'])(
      'refuses a TENANT token on the unreleased route %s',
      async (route) => {
        await expect(
          Promise.resolve(
            makeGuard().canActivate(
              httpContext((Probe.prototype as any)[route], { headers: {}, user: tenantPrincipal() }),
            ),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it.each(['publicRoute', 'undecorated', 'protectedRoute'])(
      'refuses a USER token on the unreleased route %s',
      async (route) => {
        await expect(
          Promise.resolve(
            makeGuard().canActivate(
              httpContext((Probe.prototype as any)[route], { headers: {}, user: userWithToken() }),
            ),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it('answers 401 for a token credential that reached it unauthenticated — even on a public route', async () => {
      const { token } = generateApiToken('ltt');
      await expect(
        Promise.resolve(
          makeGuard().canActivate(
            httpContext(Probe.prototype.publicRoute, { headers: { authorization: `Bearer ${token}` } }),
          ),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('lets a tenant token through on a released route', async () => {
      await expect(
        Promise.resolve(
          makeGuard().canActivate(httpContext(Probe.prototype.released, { headers: {}, user: tenantPrincipal() })),
        ),
      ).resolves.toBe(true);
    });

    it('refuses a tenant token on a released route guarded only by S_SELF, whatever the target', async () => {
      await expect(
        Promise.resolve(
          makeGuard().canActivate(
            httpContext(Probe.prototype.releasedSelf, {
              headers: {},
              params: { id: '65f0000000000000000000ff' },
              user: tenantPrincipal(),
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('leaves an anonymous request on a public route alone (no behaviour change)', async () => {
      await expect(
        Promise.resolve(makeGuard().canActivate(httpContext(Probe.prototype.publicRoute, { headers: {} }))),
      ).resolves.toBe(true);
    });
  });
});

describe('API token invariants — the MCP OAuth consent refuses tokens', () => {
  const authorize = (user: unknown) =>
    new CoreAiMcpOAuthService({} as any).buildOAuthProvider().authorize({ client_id: 'c' }, {}, { req: { user } });

  it('refuses a tenant token and a user token', async () => {
    await expect(authorize(tenantPrincipal())).rejects.toThrow(/access_denied/);
    await expect(authorize(userWithToken())).rejects.toThrow(/access_denied/);
  });

  it('still hands a session user to authorizeConsent()', async () => {
    // The default authorizeConsent() is unimplemented — reaching it proves the request was passed on.
    await expect(authorize({ id: 'u1', roles: [] })).rejects.toThrow(/authorizeConsent is not implemented/);
  });
});
