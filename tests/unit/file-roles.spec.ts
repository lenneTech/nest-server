import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { CoreFileController } from '../../src/core/modules/file/core-file.controller';
import { CoreFileResolver } from '../../src/core/modules/file/core-file.resolver';
import { applyFileRoles, FILE_ROLE_DEFAULTS } from '../../src/core/modules/file/file-roles.helper';

/**
 * These tests are the only regression guard the four resolver members have.
 *
 * `CoreFileResolver` is registered by no module in this repo — `src/server` ships
 * a hand-written `FileResolver` that does not extend it — so the e2e suite
 * exercises a different class entirely. An `@Roles` regression on the core
 * resolver (the shape that made `deleteFile` anonymously callable) would
 * therefore ship green without an assertion at this level.
 */
const rolesOf = (fn: unknown): string[] | undefined => Reflect.getMetadata('roles', fn as object);

const CONTROLLER_MEMBERS = ['getFileById', 'getFile'] as const;
const RESOLVER_DOWNLOAD_MEMBERS = ['getFileInfo'] as const;
const RESOLVER_UPLOAD_MEMBERS = ['uploadFile', 'uploadFiles'] as const;
const RESOLVER_DELETE_MEMBERS = ['deleteFile'] as const;

describe('file role metadata', () => {
  // The rejection cases below deliberately trigger `logger.warn`. Left unmuted,
  // those writes can still be in flight when the vitest worker tears down its
  // rpc channel, which surfaces as an unhandled EnvironmentTeardownError and
  // fails the run even though every assertion passed.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  beforeEach(() => {
    // Each test starts from the documented default, since applyFileRoles
    // mutates shared prototype metadata.
    applyFileRoles(undefined);
  });

  describe('defaults', () => {
    it('gates every core file endpoint with ADMIN when nothing is configured', () => {
      for (const member of CONTROLLER_MEMBERS) {
        expect(rolesOf(CoreFileController.prototype[member]), member).toEqual([RoleEnum.ADMIN]);
      }
      for (const member of [...RESOLVER_DOWNLOAD_MEMBERS, ...RESOLVER_UPLOAD_MEMBERS, ...RESOLVER_DELETE_MEMBERS]) {
        expect(rolesOf(CoreFileResolver.prototype[member]), member).toEqual([RoleEnum.ADMIN]);
      }
    });

    it('never leaves S_EVERYONE on a core file endpoint', () => {
      // The exact regression this module was hardened against: S_EVERYONE makes
      // the roles guard return true WITHOUT authenticating.
      const all = [
        ...CONTROLLER_MEMBERS.map((m) => rolesOf(CoreFileController.prototype[m])),
        ...[...RESOLVER_DOWNLOAD_MEMBERS, ...RESOLVER_UPLOAD_MEMBERS, ...RESOLVER_DELETE_MEMBERS].map((m) =>
          rolesOf(CoreFileResolver.prototype[m]),
        ),
      ];
      for (const roles of all) {
        expect(roles).not.toContain(RoleEnum.S_EVERYONE);
      }
    });

    it('keeps the class-level ADMIN so an inherited member can never end up role-free', () => {
      expect(Reflect.getMetadata('roles', CoreFileController)).toEqual([RoleEnum.ADMIN]);
      expect(Reflect.getMetadata('roles', CoreFileResolver)).toEqual([RoleEnum.ADMIN]);
    });
  });

  describe('configuration', () => {
    it('applies each knob to exactly its own members', () => {
      applyFileRoles({ deleteRoles: ['d'], downloadRoles: ['a'], uploadRoles: ['u'] });

      expect(rolesOf(CoreFileController.prototype.getFileById)).toEqual(['a']);
      expect(rolesOf(CoreFileController.prototype.getFile)).toEqual(['a']);
      expect(rolesOf(CoreFileResolver.prototype.getFileInfo)).toEqual(['a']);
      expect(rolesOf(CoreFileResolver.prototype.uploadFile)).toEqual(['u']);
      expect(rolesOf(CoreFileResolver.prototype.uploadFiles)).toEqual(['u']);
      expect(rolesOf(CoreFileResolver.prototype.deleteFile)).toEqual(['d']);
    });

    it('accepts project-specific role names, not just RoleEnum members', () => {
      // @Roles() is (...roles: string[]), so a project may gate on its own roles.
      applyFileRoles({ downloadRoles: ['company-admin', 'editor'] });
      expect(rolesOf(CoreFileController.prototype.getFileById)).toEqual(['company-admin', 'editor']);
    });

    it('leaves unconfigured knobs at their default', () => {
      applyFileRoles({ downloadRoles: [RoleEnum.S_USER] });

      expect(rolesOf(CoreFileController.prototype.getFileById)).toEqual([RoleEnum.S_USER]);
      expect(rolesOf(CoreFileResolver.prototype.uploadFile)).toEqual(FILE_ROLE_DEFAULTS.uploadRoles);
      expect(rolesOf(CoreFileResolver.prototype.deleteFile)).toEqual(FILE_ROLE_DEFAULTS.deleteRoles);
    });

    it('can widen downloads to S_EVERYONE when a project asks for it explicitly', () => {
      applyFileRoles({ downloadRoles: [RoleEnum.S_EVERYONE] });
      expect(rolesOf(CoreFileController.prototype.getFileById)).toEqual([RoleEnum.S_EVERYONE]);
      // …without dragging the destructive members along.
      expect(rolesOf(CoreFileResolver.prototype.deleteFile)).toEqual([RoleEnum.ADMIN]);
    });
  });

  describe('rejects input that would silently open the routes', () => {
    // An all-empty role set makes the guard treat the endpoint as "no roles
    // required" and return true, so honouring [] literally would do the exact
    // opposite of what it looks like.
    it.each([
      ['empty array', []],
      ['non-array', 'admin' as unknown as string[]],
      ['array with non-string entries', [123 as unknown as string]],
      ['null', null as unknown as string[]],
    ])('falls back to the default for %s', (_label, value) => {
      applyFileRoles({ downloadRoles: value });
      expect(rolesOf(CoreFileController.prototype.getFileById)).toEqual(FILE_ROLE_DEFAULTS.downloadRoles);
    });
  });
});
