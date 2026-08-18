import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { CoreFileAccessAuditInitializer } from '../../src/core/modules/file/core-file-access-audit.initializer';
import { CoreFileController } from '../../src/core/modules/file/core-file.controller';
import { warnOnUndecidedEffectiveFileAccess, warnOnUndecidedFileAccess } from '../../src/core/modules/file/file-roles.config';
import { applyFileRoles } from '../../src/core/modules/file/file-roles.helper';

/**
 * The §16 boot warning used to read CONFIGURATION only, and was therefore blind to the one shape it
 * most needed to see: a project subclass that RE-DECLARES a download handler with its own
 * `@Roles()`.
 *
 * WHY THE OLD SHAPE WAS BLIND, in three steps that were each individually documented and correct:
 *
 *  1. `applyFileRoles()` writes the configured roles onto `CoreFileController.prototype.getFileById`
 *     — the BASE class function, targeted by name.
 *  2. Decorator metadata lives on the FUNCTION OBJECT. A subclass that re-declares the member is a
 *     different function carrying its own `@Roles()`, and it is that function Nest registers. The
 *     framework's configuration never reaches the route.
 *  3. The warning decided from `resolveRoles(key, fileConfig)`, which still answered `[ADMIN]`.
 *
 * So the deployment whose downloads were actually open to everyone was precisely the one that got a
 * clean bill of health. Two independent consumer projects shipped exactly that.
 *
 * WHAT CLOSES IT — `CoreFileAccessAuditInitializer` reads the roles off the REGISTERED class at
 * `onApplicationBootstrap`, when the route table exists, and reports only what the configuration
 * cannot account for. `applyFileRoles()` is untouched: rewriting an override's metadata would
 * silently relax a route a project pinned on purpose, so this reports rather than corrects.
 *
 * This file replaces `file-access-warning-subclass-blind-spot.spec.ts`, whose closing assertion was
 * `expect(message).toBeUndefined()` and which said in its own docblock that teaching the warning to
 * see this would flip it. It has flipped.
 *
 * @regression   11.35.x — `warnOnUndecidedFileAccess()` read configuration only, so a subclassed
 *   `getFileById()` carrying `@Roles(S_EVERYONE)` served anonymous downloads while the boot check
 *   reported admin-only. The gap was invisible to every existing test because they all asked the
 *   configuration the same question it was already answering correctly.
 * @seen-failing Make `CoreFileAccessAuditInitializer.effectiveRoles()` ignore the handler's own
 *   metadata (`const handlerRoles: string[] = [];`), which re-introduces the blind spot exactly —
 *   registered as mutation `file-access-audit-ignores-handler-roles` in
 *   `tests/regression-mutations.json`. The override cases go red while the admin-only and
 *   config-explained cases stay green, so the failure is the blind spot and not a broken fixture.
 */

/** The shape `README.md § Overriding` calls WRONG — and which nothing at boot used to report. */
class ProjectFileController extends CoreFileController {
  @Roles(RoleEnum.S_EVERYONE)
  override async getFileById(...args: Parameters<CoreFileController['getFileById']>) {
    return super.getFileById(...args);
  }
}

/** A subclass that inherits every member — the case configuration governs correctly. */
class InheritingFileController extends CoreFileController {}

/**
 * Drive the initializer over a chosen set of registered instances.
 *
 * `Object.create` rather than `new`: the constructor wants a `CoreFileService`, which wants a live
 * Mongo connection, and none of that participates in the question under test. What matters is the
 * prototype chain — that is what `instanceof` and `proto[method]` resolve against, and it is
 * identical either way.
 */
function auditOf(controllers: object[], fileConfig?: Record<string, unknown>): string | undefined {
  const discovery = {
    getControllers: () => controllers.map(instance => ({ instance })),
    getProviders: () => [],
  };
  const initializer = new CoreFileAccessAuditInitializer(discovery as any);

  // Reach the pure decision directly rather than through onApplicationBootstrap(), so the test does
  // not depend on the global ConfigService — the wiring that reads it is asserted separately below.
  return warnOnUndecidedEffectiveFileAccess({
    fileConfig: fileConfig as any,
    handlers: (initializer as any).collectHandlers(),
    hasPerFileRule: false,
    multiTenancyEnabled: false,
  });
}

describe('effective file access — roles read off the REGISTERED class', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    // Same reason as file-roles.spec.ts: an in-flight logger write can outlive the worker.
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  beforeEach(() => {
    // `applyFileRoles` mutates shared prototype metadata — start from the documented default.
    applyFileRoles(undefined);
  });

  describe('the mechanism the audit has to see through', () => {
    it('applies the admin-only default to the BASE handler', () => {
      expect(Reflect.getMetadata('roles', CoreFileController.prototype.getFileById)).toEqual([RoleEnum.ADMIN]);
    });

    it('but the subclass override is a DIFFERENT function that keeps its own S_EVERYONE', () => {
      expect(Reflect.getMetadata('roles', ProjectFileController.prototype.getFileById)).toEqual([
        RoleEnum.S_EVERYONE,
      ]);
      expect(ProjectFileController.prototype.getFileById).not.toBe(CoreFileController.prototype.getFileById);
    });
  });

  describe('what the audit reports', () => {
    it('WARNS about an override that opens a route the configuration says is admin-only', () => {
      // The finding. Before this initializer existed, this expectation was `toBeUndefined()`.
      const message = auditOf([Object.create(ProjectFileController.prototype)]);

      expect(message).toContain('open beyond platform admins through roles declared in your own class');
      expect(message).toContain('ProjectFileController.getFileById');
      expect(message).toContain(RoleEnum.S_EVERYONE);
    });

    it('names the member as REGISTERED, not as the core base class', () => {
      // An operator has to be able to go straight to the file that did it.
      const message = auditOf([Object.create(ProjectFileController.prototype)]);

      expect(message).not.toContain('CoreFileController.getFileById');
    });

    it('tells the reader WHY their configuration did not apply', () => {
      // Without this the obvious repair is to widen file.downloadRoles, which changes nothing at all
      // for a re-declared member.
      const message = auditOf([Object.create(ProjectFileController.prototype)]);

      expect(message).toContain('RE-DECLARED');
      expect(message).toContain('do NOT apply');
    });

    it('stays silent for a subclass that INHERITS its members', () => {
      // The case configuration already governs — `applyFileRoles()` reached it through the prototype
      // chain, so config and reality agree and there is nothing extra to report.
      expect(auditOf([Object.create(InheritingFileController.prototype)])).toBeUndefined();
    });

    it('does NOT double-warn when the widening came from the configuration', () => {
      // A widened config is the OTHER warning's subject. Reporting it twice, in different words,
      // trains an operator to skim both.
      applyFileRoles({ downloadRoles: [RoleEnum.S_USER] } as any);

      const message = auditOf([Object.create(InheritingFileController.prototype)], {
        downloadRoles: [RoleEnum.S_USER],
      });

      expect(message).toBeUndefined();
      // …and the configuration-side warning does still cover it, so the case is not lost.
      expect(
        warnOnUndecidedFileAccess({
          fileConfig: { downloadRoles: [RoleEnum.S_USER] } as any,
          hasPerFileRule: false,
          multiTenancyEnabled: false,
        }),
      ).toContain('The file gate is open beyond platform admins');
    });

    it('reports only the EXTRA roles when an override widens further than the configuration', () => {
      // Both are true at once: config says S_USER, the override says everyone. Only the part the
      // other warning cannot see belongs here.
      applyFileRoles({ downloadRoles: [RoleEnum.S_USER] } as any);

      const message = auditOf([Object.create(ProjectFileController.prototype)], {
        downloadRoles: [RoleEnum.S_USER],
      });

      expect(message).toContain(RoleEnum.S_EVERYONE);
      expect(message).not.toContain(RoleEnum.S_USER);
    });

    it('is silenced by an overridden checkRights(), like the configuration-side warning', () => {
      // Somebody declared a per-file rule; grading it is beyond what a boot check can do.
      const discovery = {
        getControllers: () => [{ instance: Object.create(ProjectFileController.prototype) }],
        getProviders: () => [],
      };
      const initializer = new CoreFileAccessAuditInitializer(discovery as any);

      expect(
        warnOnUndecidedEffectiveFileAccess({
          handlers: (initializer as any).collectHandlers(),
          hasPerFileRule: true,
          multiTenancyEnabled: false,
        }),
      ).toBeUndefined();
    });

    it('is silenced by a declared file.access preset', () => {
      expect(auditOf([Object.create(ProjectFileController.prototype)], { access: 'owner' })).toBeUndefined();
    });

    it('says nothing at all when no file endpoint is registered', () => {
      // A service-only integration has no route to be wrong about; the constructor-side warning
      // remains the right signal there.
      expect(auditOf([])).toBeUndefined();
    });
  });

  describe('a class-level @Roles() on the subclass counts too', () => {
    it('is unioned in, exactly as mergeRolesMetadata does for the guards', () => {
      // Reading only the handler would miss this: the guards evaluate handler ∪ class, so a
      // class-level widening reaches every member the subclass serves.
      @Roles(RoleEnum.S_EVERYONE)
      class ClassWideController extends CoreFileController {}

      const message = auditOf([Object.create(ClassWideController.prototype)]);

      expect(message).toContain(RoleEnum.S_EVERYONE);
      expect(message).toContain('ClassWideController.getFileById');
    });
  });
});
