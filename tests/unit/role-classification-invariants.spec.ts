import { afterEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { RoleScope, roleScopeRegistry } from '../../src/core/modules/tenant/core-role-scope.registry';

import {
  GLOBAL_ONLY_ROLES,
  isForbiddenMembershipRole,
  isGlobalOnlyRole,
  isSystemRole,
  looksLikeSystemRole,
  RoleEnum,
  SYSTEM_ROLE_PREFIX,
} from '../../src/core/common/enums/role.enum';
import {
  assertRoleVocabularyIsCoherent,
  checkRoleAccess,
  resolveGlobalAndTenantRoles,
  tenantSatisfiableRoles,
} from '../../src/core/modules/tenant/core-tenant.helpers';

/**
 * Structural invariants over the role vocabulary.
 *
 * These cannot be observed by exercising the code — they are properties of the DECLARATIONS, and
 * the failure mode they guard against is a future edit silently disarming a safety property rather
 * than breaking a behaviour. See `.claude/rules/architecture.md` → "Structural invariants".
 *
 * The one that earns its keep: every RoleEnum member must be CLASSIFIED. Adding
 * `RoleEnum.SUPPORT = 'support'` without deciding whether it is platform authority would silently
 * turn every pre-existing tenant membership named 'support' into a privilege-escalation path —
 * retroactively, with no code change anywhere near the tenant module. This test forces the
 * decision at the moment the role is added.
 */
describe('role classification invariants', () => {
  const allRoles = Object.values(RoleEnum) as string[];

  it('classifies every RoleEnum member as either a system role or a global-only role', () => {
    const unclassified = allRoles.filter((role) => !isSystemRole(role) && !isGlobalOnlyRole(role));

    expect(
      unclassified,
      `Unclassified RoleEnum member(s): ${unclassified.join(', ')}.\n\n`
        + 'Every framework role must be one of:\n'
        + `  - a SYSTEM role  (prefix "${SYSTEM_ROLE_PREFIX}") — a runtime-context check, never stored\n`
        + '  - a GLOBAL-ONLY role — platform authority, resolved against user.roles only\n\n'
        + 'Add it to GLOBAL_ONLY_ROLES in src/core/common/enums/role.enum.ts if it carries platform\n'
        + 'authority. Leaving it unclassified means a tenant membership with the same name would be\n'
        + 'compared against it by exact string match — a customer could then grant themselves that\n'
        + 'role by naming their tenant role accordingly.',
    ).toEqual([]);
  });

  it('keeps the two classifications disjoint', () => {
    const both = allRoles.filter((role) => isSystemRole(role) && isGlobalOnlyRole(role));
    expect(both, 'A role cannot be both a runtime-context check and platform authority').toEqual([]);
  });

  it('treats every classified role as unusable for a tenant membership', () => {
    for (const role of allRoles) {
      expect(isForbiddenMembershipRole(role), `${role} must not be assignable as a membership role`).toBe(true);
    }
  });

  it('routes global-only roles away from the tenant side of the split', () => {
    const { global, tenant } = resolveGlobalAndTenantRoles([RoleEnum.ADMIN, 'tenantAdmin', 'auditor']);

    expect(global).toEqual([RoleEnum.ADMIN]);
    expect(tenant).toEqual(['tenantAdmin', 'auditor']);
  });

  it('leaves project role names untouched, including ones that merely contain a reserved substring', () => {
    // 'gs_editor' contains "s_" but does not start with it; 'administrator' contains "admin" but is
    // a different string. Neither may be swept up by the guards.
    for (const role of ['tenantAdmin', 'spaceAdmin', 'gs_editor', 'administrator', 'owner']) {
      expect(isForbiddenMembershipRole(role), `${role} is a legitimate project role`).toBe(false);
    }

    const { global, tenant } = resolveGlobalAndTenantRoles(['gs_editor', 'administrator']);
    expect(global).toEqual([]);
    expect(tenant).toEqual(['gs_editor', 'administrator']);
  });

  it('refuses membership role names that only differ by case or padding', () => {
    // hasRole() compares exactly, so these never GRANT anything — but they pass an eyeball review
    // as legitimate roles, and become live the moment anything normalizes role strings.
    for (const role of [' s_self', 'S_SELF', ' Admin ', 'ADMIN']) {
      expect(isForbiddenMembershipRole(role), `${role} must not be assignable as a membership role`).toBe(true);
    }
  });

  it('keeps looksLikeSystemRole strictly broader than isSystemRole', () => {
    // The storage rule must never accept something the runtime rule would call a system role.
    for (const role of [...allRoles, ' s_self', 'S_SELF', 's_manager']) {
      if (isSystemRole(role)) {
        expect(looksLikeSystemRole(role), `${role}: storage rule must not be narrower than runtime rule`).toBe(true);
      }
    }
  });

  it('exposes GLOBAL_ONLY_ROLES as a non-empty, readonly-by-convention list', () => {
    expect(GLOBAL_ONLY_ROLES.length).toBeGreaterThan(0);
    expect(GLOBAL_ONLY_ROLES).toContain(RoleEnum.ADMIN);
  });

  /**
   * Pins the trap behind the `tenantRoles.length > 0 &&` guards in CoreTenantGuard and
   * checkRestricted. `checkRoleAccess` is permissive on an EMPTY required-roles list — which is
   * correct in its own right ("nothing required" = "allowed") but becomes an authorization hole
   * once required roles are split by source: a handler requiring only `@Roles(ADMIN)` leaves the
   * tenant half empty, so an unguarded call would grant every tenant member access to it.
   *
   * A linter flags the sibling `.some()` length checks as useless and it is right about those.
   * These two are not the same shape, so this test exists to make that concrete rather than
   * relying on the code comment surviving a cleanup pass.
   */
  describe('role scope registry', () => {
    afterEach(() => {
      roleScopeRegistry.clear();
      ConfigService.setConfig({ multiTenancy: {} } as any);
    });

    it('classifies by SCOPE rather than by name, so DB-defined roles can be added later', () => {
      roleScopeRegistry.register({
        globalRoles: () => ['auditor'],
        tenantRoles: () => ['owner', 'tenantAdmin'],
      });

      expect(roleScopeRegistry.scopeOf('auditor')).toBe(RoleScope.GLOBAL);
      expect(roleScopeRegistry.scopeOf('tenantAdmin')).toBe(RoleScope.TENANT);
      expect(roleScopeRegistry.scopeOf(RoleEnum.ADMIN)).toBe(RoleScope.GLOBAL);
      expect(roleScopeRegistry.scopeOf(RoleEnum.S_SELF)).toBe(RoleScope.SYSTEM);
      expect(roleScopeRegistry.scopeOf('never-declared')).toBe(RoleScope.UNKNOWN);
    });

    it('never lets a project demote a framework global role to tenant scope', () => {
      // A source claiming ADMIN is tenant-scoped must not win — that would reopen the exact
      // escalation this release closes.
      roleScopeRegistry.register({ globalRoles: () => [], tenantRoles: () => [RoleEnum.ADMIN] });

      expect(roleScopeRegistry.scopeOf(RoleEnum.ADMIN)).toBe(RoleScope.GLOBAL);
      expect(resolveGlobalAndTenantRoles([RoleEnum.ADMIN]).tenant).toEqual([]);
    });

    it('reports a role declared in both scopes as a conflict', () => {
      roleScopeRegistry.register({ globalRoles: () => ['auditor'], tenantRoles: () => ['auditor', 'owner'] });
      expect(roleScopeRegistry.conflicts()).toEqual(['auditor']);
    });

    it('excludes global roles from tenant-satisfiable regardless of strict mode', () => {
      ConfigService.setConfig({ multiTenancy: { globalOnlyRoles: ['auditor'] } } as any);

      // Non-strict: undeclared roles stay satisfiable (backward compatible), globals never are.
      expect(tenantSatisfiableRoles([RoleEnum.ADMIN, 'auditor', 'somethingUndeclared'])).toEqual([
        'somethingUndeclared',
      ]);
    });

    it('narrows to declared tenant roles only when strictMembershipRoles is on', () => {
      ConfigService.setConfig({
        multiTenancy: { roleHierarchy: { member: 1, owner: 2 }, strictMembershipRoles: true },
      } as any);

      expect(tenantSatisfiableRoles(['owner', 'undeclared'])).toEqual(['owner']);
    });
  });

  /**
   * The overwhelming majority of projects never enable multiTenancy. For them the release must be
   * a no-op on role RESOLUTION — the only intended change is that `s_*` can no longer be stored.
   *
   * `checkFieldRoleAccess` (restricted.decorator) runs on every field check regardless of
   * multiTenancy, so it is the one path where a tenant-motivated change could leak into a
   * single-tenant project. These cases pin that it does not.
   */
  describe('with multiTenancy NOT configured', () => {
    afterEach(() => {
      roleScopeRegistry.clear();
      ConfigService.setConfig({ multiTenancy: {} } as any);
    });

    it('resolves ADMIN and project roles exactly as before', () => {
      ConfigService.setConfig({} as any);
      roleScopeRegistry.clear();

      // ADMIN against user.roles — unchanged.
      expect(checkRoleAccess([RoleEnum.ADMIN], [RoleEnum.ADMIN], undefined)).toBe(true);
      expect(checkRoleAccess([RoleEnum.ADMIN], ['editor'], undefined)).toBe(false);

      // A project role the framework knows nothing about — unchanged exact match.
      expect(checkRoleAccess(['editor'], ['editor'], undefined)).toBe(true);
      expect(checkRoleAccess(['editor'], ['viewer'], undefined)).toBe(false);

      // Without a tenant role there is only one source, so the split cannot change the outcome:
      // whichever half a role lands in, it is resolved against user.roles either way.
      const { global, tenant } = resolveGlobalAndTenantRoles([RoleEnum.ADMIN, 'editor']);
      expect(global).toEqual([RoleEnum.ADMIN]);
      expect(tenant).toEqual(['editor']);
    });

    it('does not deny anything extra when strictMembershipRoles is off (the default)', () => {
      ConfigService.setConfig({} as any);
      roleScopeRegistry.clear();

      // Undeclared roles stay satisfiable — no silent lockout for single-tenant projects.
      expect(tenantSatisfiableRoles(['editor', 'viewer'])).toEqual(['editor', 'viewer']);
    });

    it('never fails the boot check when multiTenancy is absent or disabled', () => {
      ConfigService.setConfig({} as any);
      expect(() => assertRoleVocabularyIsCoherent()).not.toThrow();

      // Even a vocabulary that WOULD be rejected is ignored while disabled.
      ConfigService.setConfig({ multiTenancy: { enabled: false, roleHierarchy: { admin: 3 } } } as any);
      expect(() => assertRoleVocabularyIsCoherent()).not.toThrow();
    });
  });

  describe('boot-time vocabulary check', () => {
    afterEach(() => ConfigService.setConfig({ multiTenancy: {} } as any));

    it('refuses a tenant hierarchy that reuses a framework role name', () => {
      // This is the configuration the framework's OWN docs used to recommend.
      ConfigService.setConfig({
        multiTenancy: { roleHierarchy: { admin: 3, member: 1, owner: 4 } },
      } as any);

      expect(() => assertRoleVocabularyIsCoherent()).toThrow(/reserved framework role name/);
    });

    it('refuses a role declared as both global and tenant scoped', () => {
      ConfigService.setConfig({
        multiTenancy: { globalOnlyRoles: ['auditor'], roleHierarchy: { auditor: 2, member: 1 } },
      } as any);

      expect(() => assertRoleVocabularyIsCoherent()).toThrow(/BOTH in globalOnlyRoles and as tenant roles/);
    });

    it('refuses a system role declared as global', () => {
      ConfigService.setConfig({ multiTenancy: { globalOnlyRoles: [RoleEnum.S_USER] } } as any);
      expect(() => assertRoleVocabularyIsCoherent()).toThrow(/system role/i);
    });

    it('accepts the recommended vocabulary', () => {
      ConfigService.setConfig({
        multiTenancy: {
          globalOnlyRoles: ['auditor'],
          roleHierarchy: { member: 1, owner: 3, tenantAdmin: 2 },
        },
      } as any);

      expect(() => assertRoleVocabularyIsCoherent()).not.toThrow();
    });

    it('stays silent when multiTenancy is disabled', () => {
      ConfigService.setConfig({} as any);
      expect(() => assertRoleVocabularyIsCoherent()).not.toThrow();
    });
  });

  it('treats an empty required-roles list as permissive — hence the length guards at both call sites', () => {
    expect(checkRoleAccess([], ['anything'], undefined)).toBe(true);
    expect(checkRoleAccess([], undefined, 'member')).toBe(true);

    // The split routes ADMIN away from the tenant half, leaving it empty.
    const { tenant } = resolveGlobalAndTenantRoles([RoleEnum.ADMIN]);
    expect(tenant).toEqual([]);
    expect(
      checkRoleAccess(tenant, undefined, 'member'),
      'an unguarded call with the empty tenant half would grant any member ADMIN-only access',
    ).toBe(true);
  });
});
