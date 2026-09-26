/**
 * The role guards may only hand non-system roles to the tenant guard while one actually RUNS.
 *
 * @regression   11.41.x — RolesGuard and BetterAuthRolesGuard handed every non-system role to
 *   CoreTenantGuard as soon as `multiTenancy` was CONFIGURED, without asking whether a tenant guard
 *   was REGISTERED. With the two out of step — a process that booted another app first, a config
 *   merged after module registration, a project that replaced the tenant module — `@Roles(ADMIN)`
 *   let every authenticated caller through, because the guard that was meant to check it never ran.
 *   Surfaced while testing API tokens: an ADMIN route answered 200 to a caller without the role.
 * @seen-failing Make `delegatesRolesToTenantGuard()` delegate whenever multi-tenancy is configured —
 *   registered as mutation `role-guards-delegate-without-tenant-guard` in tests/regression-mutations.json.
 */
import { Controller, ExecutionContext, ForbiddenException, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { RolesGuard } from '../../src/core/modules/auth/guards/roles.guard';
import { BetterAuthRolesGuard } from '../../src/core/modules/better-auth/better-auth-roles.guard';
import { registerActiveTenantGuard } from '../../src/core/modules/tenant/core-tenant-guard.registry';

@Controller('delegation')
class Probe {
  @Get('admin')
  @Roles(RoleEnum.ADMIN)
  admin() {}

  @Get('tenant-role')
  @Roles('owner')
  tenantRole() {}
}

function httpContext(handler: any, user: any): ExecutionContext {
  const request = { headers: {}, user };
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

/** A signed-in user WITHOUT the admin role — flagged the way the Better-Auth middleware flags it. */
const plainUser = () => ({
  _authenticatedViaBetterAuth: true,
  hasRole: (roles: string[]) => roles.includes('none'),
  id: 'u1',
  roles: [] as string[],
});

const adminUser = () => ({
  _authenticatedViaBetterAuth: true,
  hasRole: (roles: string[]) => roles.includes(RoleEnum.ADMIN),
  id: 'u2',
  roles: [RoleEnum.ADMIN],
});

const guards: Array<[string, () => { canActivate: (context: ExecutionContext) => boolean | Promise<boolean> }]> = [
  ['BetterAuthRolesGuard', () => new BetterAuthRolesGuard()],
  ['RolesGuard', () => new RolesGuard(new Reflector())],
];

describe('Role guards — delegation to the tenant guard requires a registered tenant guard', () => {
  beforeAll(() => {
    ConfigService.setConfig({ env: 'local', multiTenancy: {} } as any, { reInit: true, warn: false });
  });

  afterAll(() => {
    ConfigService.setConfig({} as any, { reInit: true, warn: false });
  });

  describe.each(guards)('%s', (_name, makeGuard) => {
    it('refuses @Roles(ADMIN) to a non-admin while NO tenant guard is registered', async () => {
      await expect(
        Promise.resolve(makeGuard().canActivate(httpContext(Probe.prototype.admin, plainUser()))),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('still admits the admin while no tenant guard is registered', async () => {
      await expect(
        Promise.resolve(makeGuard().canActivate(httpContext(Probe.prototype.admin, adminUser()))),
      ).resolves.toBeTruthy();
    });

    it('refuses a tenant role nobody can resolve while no tenant guard is registered', async () => {
      await expect(
        Promise.resolve(makeGuard().canActivate(httpContext(Probe.prototype.tenantRole, plainUser()))),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('delegates as before once a tenant guard IS registered', async () => {
      const release = registerActiveTenantGuard();
      try {
        await expect(
          Promise.resolve(makeGuard().canActivate(httpContext(Probe.prototype.tenantRole, plainUser()))),
        ).resolves.toBeTruthy();
      } finally {
        release();
      }
    });
  });
});
