import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../../src/core/common/services/request-context.service';
import { assertTenantRole, hasTenantRole } from '../../src/core/modules/tenant/core-tenant-role.helper';

/**
 * Unit Tests: the service-level tenant role check.
 *
 * `@Roles()` protects a controller or resolver method. A service is reached from other entry points
 * as well — MCP tools, AI tools, queue processors, another service — and on those paths a tenant role
 * the controller demands is demanded by nobody. `assertTenantRole()` makes the service itself refuse,
 * decided the way CoreTenantGuard decides a `@Roles()` on the tenant-header path.
 *
 * Work without a client request (cron, migration, seed) is the system's own and passes. An ANONYMOUS
 * client request does not: treating "no current user" as system work would wave through every caller
 * of a public route.
 *
 * @regression   11.42.0 — a tenant role enforced only by @Roles() on a controller was bypassed by
 *   every entry point that calls the service directly (MCP tools, AI tools).
 * @seen-failing Make `assertTenantRole()` never refuse in
 *   src/core/modules/tenant/core-tenant-role.helper.ts — registered as mutation
 *   `tenant-role-assert-inert` in tests/regression-mutations.json.
 */
describe('assertTenantRole / hasTenantRole', () => {
  let previousConfig: unknown;

  beforeAll(() => {
    previousConfig = ConfigService.configFastButReadOnly;
    ConfigService.setConfig({ ...(previousConfig as object), multiTenancy: {} } as any, { reInit: true });
  });

  afterAll(() => {
    ConfigService.setConfig((previousConfig ?? {}) as any, { reInit: true });
  });

  const member = (tenantRole: string | undefined, extra: Partial<IRequestContext> = {}): IRequestContext => ({
    currentUser: { id: 'user-1', roles: [] },
    fromRequest: true,
    tenantId: tenantRole ? 'tenant-a' : undefined,
    tenantRole,
    ...extra,
  });
  const inContext = <T>(context: IRequestContext | undefined, fn: () => T): T =>
    context ? RequestContext.run(context, fn) : fn();

  describe('a signed-in caller in tenant context', () => {
    it('refuses a role below the required one', () => {
      expect(() => inContext(member('member'), () => assertTenantRole('manager'))).toThrow(ForbiddenException);
      expect(inContext(member('member'), () => hasTenantRole('manager'))).toBe(false);
    });

    it('accepts the required role and every role above it in the hierarchy', () => {
      expect(() => inContext(member('manager'), () => assertTenantRole('manager'))).not.toThrow();
      expect(() => inContext(member('owner'), () => assertTenantRole('manager'))).not.toThrow();
    });

    it('reads several roles as alternatives', () => {
      expect(() => inContext(member('member'), () => assertTenantRole(['owner', 'member']))).not.toThrow();
    });

    it('refuses a tenant role outside tenant context — no membership, nothing to compare', () => {
      expect(() => inContext(member(undefined), () => assertTenantRole('member'))).toThrow(ForbiddenException);
    });

    it('never lets a membership role answer for a global role', () => {
      // A customer may name a membership role 'admin'; it must not satisfy RoleEnum.ADMIN.
      expect(() => inContext(member(RoleEnum.ADMIN), () => assertTenantRole(RoleEnum.ADMIN))).toThrow(
        ForbiddenException,
      );
    });

    it('accepts a global role from user.roles', () => {
      const admin = member('member', { currentUser: { id: 'admin-1', roles: [RoleEnum.ADMIN] } });
      expect(() => inContext(admin, () => assertTenantRole(RoleEnum.ADMIN))).not.toThrow();
    });

    it('accepts an administrator under adminBypass, as the guard does', () => {
      const bypass = member(undefined, {
        currentUser: { id: 'admin-1', roles: [RoleEnum.ADMIN] },
        isAdminBypass: true,
      });
      expect(() => inContext(bypass, () => assertTenantRole('owner'))).not.toThrow();
    });

    it('uses the given message', () => {
      expect(() => inContext(member('member'), () => assertTenantRole('owner', 'Only owners may do this'))).toThrow(
        'Only owners may do this',
      );
    });
  });

  describe('callers without a signed-in user', () => {
    it('passes system work that runs outside any request context (cron, migration, seed)', () => {
      expect(() => assertTenantRole('owner')).not.toThrow();
    });

    it('passes system work inside a context that no client request created', () => {
      // e.g. RequestContext.runWithBypassTenantGuard() in a cron job
      expect(() => inContext({ bypassTenantGuard: true }, () => assertTenantRole('owner'))).not.toThrow();
    });

    /**
     * @regression   11.42.0 — "no current user" was read as system work, so an anonymous request
     *   through a public route passed a service-level tenant role check.
     * @seen-failing Drop the `fromRequest` condition from the system-work exemption in
     *   src/core/modules/tenant/core-tenant-role.helper.ts — registered as mutation
     *   `tenant-role-anonymous-as-system` in tests/regression-mutations.json.
     */
    it('refuses an anonymous client request with 401', () => {
      expect(() => inContext({ fromRequest: true }, () => assertTenantRole('member'))).toThrow(UnauthorizedException);
      expect(inContext({ fromRequest: true }, () => hasTenantRole('member'))).toBe(false);
    });
  });
});
