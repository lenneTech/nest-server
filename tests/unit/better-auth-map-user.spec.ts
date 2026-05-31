/**
 * Regression guard for CoreBetterAuthController.mapUser().
 *
 * History: pre-fix, mapUser() ignored the `_mappedUser` parameter (underscore =
 * unused) and emitted `{ email, emailVerified, id, name }` only. The DB-fetched
 * `roles` from mapSessionUser() were silently dropped, so the sign-in HTTP
 * response carried no roles. Frontend consumers (`useLtAuth().setUser()`)
 * persisted a roles-less user in `lt-auth-state`, breaking client-side admin
 * gating for every project that relies on `roles: ['admin']` (e.g.
 * nest-server-starter setup flow). At least one customer project (Volksbank IMO,
 * Linear DEV-1789) shipped a project-level mapUser() override as a workaround.
 *
 * This spec calls mapUser() directly with a synthetic sessionUser + mappedUser
 * pair — no Better-Auth runtime needed — and asserts the response contract.
 */
import { describe, expect, it } from 'vitest';

import type { BetterAuthSessionUser } from '../../src/core/modules/better-auth/core-better-auth-user.mapper';

import {
  CoreBetterAuthController,
  type CoreBetterAuthUserResponse,
} from '../../src/core/modules/better-auth/core-better-auth.controller';
import { RoleEnum } from '../../src/core/common/enums/role.enum';

// `mapUser()` is `protected` and `this`-free — we lift it from the prototype
// without invoking the constructor (which would require all Nest DI deps).
const mapUser: (sessionUser: BetterAuthSessionUser, mappedUser: any) => CoreBetterAuthUserResponse = (
  CoreBetterAuthController as any
).prototype.mapUser.bind({});

const sessionUser = (overrides: Partial<BetterAuthSessionUser> = {}): BetterAuthSessionUser => ({
  email: 'admin@test.com',
  emailVerified: true,
  id: 'ba-user-1',
  name: 'Test Admin',
  ...overrides,
});

describe('CoreBetterAuthController.mapUser', () => {
  // ===================================================================================================================
  // Roles forwarding (the actual fix)
  // ===================================================================================================================

  describe('roles forwarding', () => {
    it('forwards roles from mappedUser into the response', () => {
      const result = mapUser(sessionUser(), { roles: ['admin'] });
      expect(result.roles).toEqual(['admin']);
    });

    it('returns an empty array when mappedUser is null (e.g. unsynced user)', () => {
      const result = mapUser(sessionUser(), null);
      expect(result.roles).toEqual([]);
    });

    it('returns an empty array when mappedUser is undefined', () => {
      const result = mapUser(sessionUser(), undefined);
      expect(result.roles).toEqual([]);
    });

    it('returns an empty array when mappedUser has no roles field', () => {
      const result = mapUser(sessionUser(), { email: 'admin@test.com' });
      expect(result.roles).toEqual([]);
    });

    it('returns an empty array when mappedUser.roles is not an array (defensive)', () => {
      const result = mapUser(sessionUser(), { roles: 'admin' as any });
      expect(result.roles).toEqual([]);
    });

    it('returns an empty array when mappedUser.roles is null', () => {
      const result = mapUser(sessionUser(), { roles: null as any });
      expect(result.roles).toEqual([]);
    });

    it('forwards a multi-role array (admin + functional roles)', () => {
      const result = mapUser(sessionUser(), { roles: ['admin', 'editor', 'orga'] });
      expect(result.roles).toEqual(['admin', 'editor', 'orga']);
    });

    it('preserves an empty array as empty (not converted to undefined)', () => {
      const result = mapUser(sessionUser(), { roles: [] });
      expect(result.roles).toEqual([]);
      expect(result.roles).not.toBeUndefined();
    });
  });

  // ===================================================================================================================
  // Base shape (regression guard for the original fields)
  // ===================================================================================================================

  describe('base shape', () => {
    it('preserves the base shape (email, emailVerified, id, name) untouched', () => {
      const result = mapUser(sessionUser({ email: 'editor@test.com', name: 'Editor' }), { roles: ['editor1'] });
      expect(result).toEqual({
        email: 'editor@test.com',
        emailVerified: true,
        id: 'ba-user-1',
        name: 'Editor',
        roles: ['editor1'],
      });
    });

    it('falls back to the email-local-part when name is missing', () => {
      const result = mapUser(sessionUser({ name: undefined }), { roles: [] });
      expect(result.name).toBe('admin');
    });

    it('defaults emailVerified to false when missing on sessionUser', () => {
      const result = mapUser(sessionUser({ emailVerified: undefined }), { roles: [] });
      expect(result.emailVerified).toBe(false);
    });

    it('forwards explicit emailVerified=false', () => {
      const result = mapUser(sessionUser({ emailVerified: false }), { roles: [] });
      expect(result.emailVerified).toBe(false);
    });
  });

  // ===================================================================================================================
  // Security: explicit allow-list — extra mappedUser fields must NEVER leak
  // ===================================================================================================================

  describe('security: response is an explicit allow-list', () => {
    it('does not leak password / hash fields when mappedUser carries them', () => {
      // mapSessionUser() reads from the `users` collection. A future regression could
      // shape mappedUser closer to the raw DB document — the response must still
      // strip secrets even then. This test guards the contract independently of
      // mapSessionUser()'s current return shape.
      const result = mapUser(sessionUser(), {
        roles: ['admin'],
        password: '$2b$10$leaked.hash.value',
        passwordHash: 'should-not-leak',
        verificationToken: 'should-not-leak',
        passwordResetToken: 'should-not-leak',
        refreshTokens: ['rt1', 'rt2'],
        tempTokens: ['tmp1'],
      });

      expect((result as any).password).toBeUndefined();
      expect((result as any).passwordHash).toBeUndefined();
      expect((result as any).verificationToken).toBeUndefined();
      expect((result as any).passwordResetToken).toBeUndefined();
      expect((result as any).refreshTokens).toBeUndefined();
      expect((result as any).tempTokens).toBeUndefined();
    });

    it('does not leak internal IDs (_id, iamId) or arbitrary DB fields', () => {
      const result = mapUser(sessionUser(), {
        _id: '507f1f77bcf86cd799439011',
        iamId: 'should-not-leak-via-mapUser',
        firstName: 'should-not-leak',
        lastName: 'should-not-leak',
        avatar: 'should-not-leak',
        createdAt: new Date(),
        updatedAt: new Date(),
        roles: [],
      });

      expect((result as any)._id).toBeUndefined();
      expect((result as any).iamId).toBeUndefined();
      expect((result as any).firstName).toBeUndefined();
      expect((result as any).lastName).toBeUndefined();
      expect((result as any).avatar).toBeUndefined();
      expect((result as any).createdAt).toBeUndefined();
      expect((result as any).updatedAt).toBeUndefined();
    });

    it('returns exactly the documented response keys', () => {
      const result = mapUser(sessionUser(), { roles: ['admin'] });
      // Keys not present in the response payload (e.g. twoFactorEnabled) are
      // intentionally absent here — the base implementation only sets the
      // five fields below. Subclasses may extend this set.
      expect(Object.keys(result).sort()).toEqual(['email', 'emailVerified', 'id', 'name', 'roles']);
    });

    it('does not allow client-supplied sessionUser fields to overwrite the response shape', () => {
      // BetterAuthSessionUser comes from Better-Auth which is server-controlled.
      // Still: even if a future codepath populated additional fields, mapUser()
      // must not echo them back — the response is an explicit allow-list.
      const su = sessionUser() as any;
      su.password = 'cannot-leak-from-session';
      su.roles = ['cannot-leak-from-session'];
      su.isAdmin = true;

      const result = mapUser(su, { roles: ['admin'] });
      expect((result as any).password).toBeUndefined();
      expect((result as any).isAdmin).toBeUndefined();
      // roles MUST come from the DB-mapped user, not from the (potentially
      // forged) sessionUser argument.
      expect(result.roles).toEqual(['admin']);
    });
  });

  // ===================================================================================================================
  // Security: role values
  // ===================================================================================================================

  describe('security: role values', () => {
    it('does not strip ADMIN role (real role, must propagate)', () => {
      const result = mapUser(sessionUser(), { roles: [RoleEnum.ADMIN] });
      expect(result.roles).toContain(RoleEnum.ADMIN);
    });

    it('passes through S_-prefixed values verbatim (defense in depth — never expected in user.roles, but mapUser must not silently rewrite them)', () => {
      // Per project rule (.claude/rules/role-system.md): S_ roles are runtime
      // checks and MUST NEVER be stored in user.roles. If the DB is polluted
      // (data bug elsewhere), mapUser() should not hide the pollution — the
      // wrong data must surface so it can be detected and cleaned, not be
      // silently filtered which would mask the real bug.
      const result = mapUser(sessionUser(), { roles: [RoleEnum.S_USER, RoleEnum.S_VERIFIED] });
      expect(result.roles).toEqual([RoleEnum.S_USER, RoleEnum.S_VERIFIED]);
    });
  });

  // ===================================================================================================================
  // Override contract — protected method must remain callable from a subclass
  // ===================================================================================================================

  describe('override contract', () => {
    it('subclasses can override and call super.mapUser to extend the response', () => {
      // The base class is intentionally cast to `any` so the test does not require
      // the full Nest DI constructor surface. Because of that, TS cannot resolve
      // `super.mapUser` as a typed member and the `override` modifier would error
      // with TS4113 — call the prototype directly instead.
      class CustomController extends (CoreBetterAuthController as any) {
        public mapUser(su: BetterAuthSessionUser, mu: any): CoreBetterAuthUserResponse & { status?: string } {
          const base = (CoreBetterAuthController as any).prototype.mapUser.call(this, su, mu);
          return { ...base, status: mu?.status ?? 'unknown' };
        }
      }
      const instance = Object.create(CustomController.prototype);
      const result = instance.mapUser(sessionUser(), { roles: ['admin'], status: 'active' });
      expect(result.roles).toEqual(['admin']);
      expect(result.status).toBe('active');
      expect(result.email).toBe('admin@test.com');
    });
  });
});
