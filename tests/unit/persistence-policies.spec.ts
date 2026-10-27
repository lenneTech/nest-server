import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import {
  resolveAuditActorId,
  stampAuditOnReplace,
  stampAuditOnUpdate,
  stampAuditOnWrite,
} from '../../src/core/common/persistence/policies/audit.policy';
import {
  hashPassword,
  hashUpdatePassword,
  resetSkipPatternsCache,
} from '../../src/core/common/persistence/policies/password.policy';
import {
  isRoleChangeAllowed,
  stripRoleChanges,
  updateChangesRoles,
} from '../../src/core/common/persistence/policies/role-guard.policy';
import {
  assertNoSystemRoles,
  assertUpdateHasNoSystemRoles,
  updateMayIntroduceSystemRoles,
} from '../../src/core/common/persistence/policies/system-role.policy';
import {
  allowedTenantIds,
  assertOwnTenant,
  assertRowsInTenantScope,
  assertUnfilterableCountAllowed,
  resolveSingleTenantId,
  resolveTenantFilter,
} from '../../src/core/common/persistence/policies/tenant.policy';
import { ConfigService } from '../../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../../src/core/common/services/request-context.service';

const inContext = <T>(context: Partial<IRequestContext>, fn: () => T): T =>
  RequestContext.run({ fromRequest: true, ...context } as IRequestContext, fn);

const user = (id: string, roles: string[] = []) =>
  ({ hasRole: (required: string[]) => required.some((role) => roles.includes(role)), id, roles }) as any;

afterEach(() => {
  ConfigService.setConfig({} as any, { reInit: true });
  resetSkipPatternsCache();
});

describe('persistence policies', () => {
  describe('tenant', () => {
    const multiTenancy = (extra: Record<string, unknown> = {}) =>
      ConfigService.setConfig({ multiTenancy: { ...extra } } as any, { reInit: true });

    it('applies no filter while multi-tenancy is not configured', () => {
      expect(inContext({ tenantId: 't1' }, () => resolveTenantFilter('Doc'))).toBeUndefined();
    });

    it('treats a missing request context as system work: no filter', () => {
      multiTenancy();
      expect(resolveTenantFilter('Doc')).toBeUndefined();
    });

    it('filters by the validated tenant, else by the member tenants', () => {
      multiTenancy();
      expect(inContext({ tenantId: 't1' }, () => resolveTenantFilter('Doc'))).toEqual({ tenantId: 't1' });
      expect(inContext({ tenantIds: ['t1', 't2'] }, () => resolveTenantFilter('Doc'))).toEqual({
        tenantId: { $in: ['t1', 't2'] },
      });
    });

    it('lets an admin without a tenant header see everything', () => {
      multiTenancy();
      expect(inContext({ isAdminBypass: true }, () => resolveTenantFilter('Doc'))).toEqual({});
    });

    it('refuses tenant-scoped data without a tenant context (safety net)', () => {
      multiTenancy();
      expect(() => inContext({ currentUser: user('u1') }, () => resolveTenantFilter('Doc'))).toThrow(
        ForbiddenException,
      );
    });

    it('applies no filter under an explicit bypass or for an excluded schema', () => {
      multiTenancy({ excludeSchemas: ['Global'] });
      expect(inContext({ bypassTenantGuard: true, tenantId: 't1' }, () => resolveTenantFilter('Doc'))).toBeUndefined();
      expect(inContext({ tenantId: 't1' }, () => resolveTenantFilter('Global'))).toBeUndefined();
    });

    it('stamps writes only from a validated tenant header', () => {
      multiTenancy();
      expect(inContext({ tenantId: 't1' }, () => resolveSingleTenantId('Doc'))).toBe('t1');
      expect(inContext({ tenantIds: ['t1'] }, () => resolveSingleTenantId('Doc'))).toBeUndefined();
    });

    it('refuses a foreign tenant on create and on move, and accepts the own or none', () => {
      expect(() => assertOwnTenant('t1', 't1', true)).not.toThrow();
      expect(() => assertOwnTenant(undefined, 't1', false)).not.toThrow();
      expect(() => assertOwnTenant(null, 't1', false)).not.toThrow();
      expect(() => assertOwnTenant('t2', 't1', true)).toThrow(/create a document in a foreign tenant/);
      expect(() => assertOwnTenant('t2', 't1', false)).toThrow(/move a document to a foreign tenant/);
    });

    it('refuses an unfilterable count inside a tenant context, not for an admin without header', () => {
      multiTenancy();
      expect(() => inContext({ tenantId: 't1' }, () => assertUnfilterableCountAllowed('Doc'))).toThrow(
        ForbiddenException,
      );
      expect(() => inContext({ isAdminBypass: true }, () => assertUnfilterableCountAllowed('Doc'))).not.toThrow();
      expect(() => assertUnfilterableCountAllowed('Doc')).not.toThrow();
    });
  });

  describe('tenant row check (after-layer)', () => {
    const multiTenancy = () => ConfigService.setConfig({ multiTenancy: {} } as any, { reInit: true });

    it('derives the allowed tenants from the same decision as the read filter', () => {
      multiTenancy();
      expect(inContext({ tenantId: 't1', tenantIds: ['t1', 't2'] }, () => allowedTenantIds('Doc'))).toEqual(['t1']);
      expect(inContext({ tenantIds: ['t1', 't2'] }, () => allowedTenantIds('Doc'))).toEqual(['t1', 't2']);
      expect(inContext({ isAdminBypass: true }, () => allowedTenantIds('Doc'))).toBeUndefined();
      expect(allowedTenantIds('Doc')).toBeUndefined();
    });

    it('passes rows of the allowed tenants, and rows that do not carry the field', () => {
      multiTenancy();
      expect(() =>
        inContext({ tenantIds: ['t1', 't2'] }, () =>
          assertRowsInTenantScope('Doc', [{ tenantId: 't1' }, { tenantId: 't2' }, { name: 'projected' }, null]),
        ),
      ).not.toThrow();
    });

    it('withholds a result with a row of another tenant, or of no tenant', () => {
      multiTenancy();
      expect(() => inContext({ tenantId: 't1' }, () => assertRowsInTenantScope('Doc', [{ tenantId: 't2' }]))).toThrow(
        ForbiddenException,
      );
      expect(() => inContext({ tenantId: 't1' }, () => assertRowsInTenantScope('Doc', { tenantId: null }))).toThrow(
        ForbiddenException,
      );
    });

    it('never names the foreign tenant in the error a client receives', () => {
      multiTenancy();
      try {
        inContext({ tenantId: 't1' }, () => assertRowsInTenantScope('Doc', [{ tenantId: 'secret-tenant' }]));
        expect.unreachable();
      } catch (error) {
        expect(String((error as Error).message)).not.toContain('secret-tenant');
      }
    });

    it('checks nothing where the read filter applies nothing', () => {
      multiTenancy();
      expect(() =>
        inContext({ isAdminBypass: true }, () => assertRowsInTenantScope('Doc', [{ tenantId: 'any' }])),
      ).not.toThrow();
      expect(() => assertRowsInTenantScope('Doc', [{ tenantId: 'any' }])).not.toThrow();
    });
  });

  describe('audit', () => {
    const both = { createdBy: true, updatedBy: true };

    it('takes the actor from the current user, none for system work', () => {
      expect(resolveAuditActorId()).toBeUndefined();
      expect(inContext({ currentUser: user('u1') }, () => resolveAuditActorId())).toBe('u1');
    });

    it('stamps createdBy only on a new document without one, updatedBy always', () => {
      const created: Record<string, unknown> = {};
      stampAuditOnWrite(created, 'u1', both, true);
      expect(created).toEqual({ createdBy: 'u1', updatedBy: 'u1' });

      const kept = { createdBy: 'u0' };
      stampAuditOnWrite(kept, 'u1', both, true);
      expect(kept).toEqual({ createdBy: 'u0', updatedBy: 'u1' });

      const existing: Record<string, unknown> = {};
      stampAuditOnWrite(existing, 'u1', both, false);
      expect(existing).toEqual({ updatedBy: 'u1' });
    });

    it('stamps updates flat, in $set, and createdBy via $setOnInsert for upserts', () => {
      const update: Record<string, any> = { $set: { name: 'x' } };
      stampAuditOnUpdate(update, 'u1', both);
      expect(update).toEqual({
        $set: { name: 'x', updatedBy: 'u1' },
        $setOnInsert: { createdBy: 'u1' },
        updatedBy: 'u1',
      });
    });

    it('does not add $setOnInsert.createdBy when the update sets createdBy itself', () => {
      const update: Record<string, any> = { $set: { createdBy: 'u0' } };
      stampAuditOnUpdate(update, 'u1', both);
      expect(update.$setOnInsert).toBeUndefined();
    });

    it('stamps a replacement, keeping an existing createdBy', () => {
      const replacement: Record<string, unknown> = { createdBy: 'u0' };
      stampAuditOnReplace(replacement, 'u1', both);
      expect(replacement).toEqual({ createdBy: 'u0', updatedBy: 'u1' });
    });

    it('respects which audit fields the model stores', () => {
      const doc: Record<string, unknown> = {};
      stampAuditOnWrite(doc, 'u1', { createdBy: false, updatedBy: true }, true);
      expect(doc).toEqual({ updatedBy: 'u1' });
    });
  });

  describe('role guard', () => {
    it('allows role changes for system work, under bypass and for admins', () => {
      expect(isRoleChangeAllowed()).toBe(true);
      expect(inContext({ bypassRoleGuard: true, currentUser: user('u1') }, () => isRoleChangeAllowed())).toBe(true);
      expect(inContext({ currentUser: user('u1', [RoleEnum.ADMIN]) }, () => isRoleChangeAllowed())).toBe(true);
    });

    it('allows configured allowedRoles and refuses everybody else', () => {
      ConfigService.setConfig({ security: { mongooseRoleGuardPlugin: { allowedRoles: ['hr'] } } } as any, {
        reInit: true,
      });
      expect(inContext({ currentUser: user('u1', ['hr']) }, () => isRoleChangeAllowed())).toBe(true);
      expect(inContext({ currentUser: user('u2', ['staff']) }, () => isRoleChangeAllowed())).toBe(false);
    });

    it('detects and strips role changes in every operator form', () => {
      for (const update of [
        { roles: ['x'] },
        { $set: { roles: ['x'] } },
        { $push: { roles: 'x' } },
        { $addToSet: { roles: 'x' } },
        { $pull: { roles: 'x' } },
      ] as Record<string, any>[]) {
        expect(updateChangesRoles(update)).toBe(true);
        stripRoleChanges(update);
        expect(updateChangesRoles(update)).toBe(false);
      }
      expect(updateChangesRoles({ $set: { name: 'x' } })).toBe(false);
    });
  });

  describe('system roles', () => {
    it('refuses an introduced system role in any spelling', () => {
      for (const role of [RoleEnum.S_SELF, 'S_SELF', ' s_creator', 's_manager']) {
        expect(() => assertNoSystemRoles([role])).toThrow(BadRequestException);
      }
      expect(() => assertNoSystemRoles([RoleEnum.ADMIN, 'editor'])).not.toThrow();
    });

    it('accepts a system role that is already stored (a write-back of the same value)', () => {
      expect(() => assertNoSystemRoles(['s_self'], ['s_self'])).not.toThrow();
    });

    it('finds system roles in every update operator, including $each', () => {
      expect(updateMayIntroduceSystemRoles({ $push: { roles: { $each: ['editor', 's_self'] } } })).toBe(true);
      expect(updateMayIntroduceSystemRoles({ $set: { roles: ['editor'] } })).toBe(false);
      expect(() => assertUpdateHasNoSystemRoles({ $addToSet: { roles: 's_self' } })).toThrow(BadRequestException);
      expect(() => assertUpdateHasNoSystemRoles({ $setOnInsert: { roles: ['s_self'] } })).toThrow(BadRequestException);
    });
  });

  describe('password', () => {
    it('hashes a plaintext password with bcrypt, and leaves a bcrypt hash untouched', async () => {
      const hashed = await hashPassword('secret');
      expect(hashed).toMatch(/^\$2[aby]\$10\$/);
      expect(await hashPassword(hashed)).toBe(hashed);
    });

    it('keeps a configured sentinel value as is', async () => {
      ConfigService.setConfig({ security: { mongoosePasswordPlugin: { skipPatterns: ['^!LOCKED:'] } } } as any, {
        reInit: true,
      });
      resetSkipPatternsCache();
      expect(await hashPassword('!LOCKED:REQUIRES_PASSWORD_RESET')).toBe('!LOCKED:REQUIRES_PASSWORD_RESET');
    });

    it('hashes the password of an update, flat and in $set', async () => {
      const update: Record<string, any> = { $set: { password: 'b' }, password: 'a' };
      await hashUpdatePassword(update);
      expect(update.password).toMatch(/^\$2[aby]\$/);
      expect(update.$set.password).toMatch(/^\$2[aby]\$/);
    });
  });
});
