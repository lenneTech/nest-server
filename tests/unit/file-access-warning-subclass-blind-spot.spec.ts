import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Roles } from '../../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { CoreFileController } from '../../src/core/modules/file/core-file.controller';
import { warnOnUndecidedFileAccess } from '../../src/core/modules/file/file-roles.config';
import { applyFileRoles } from '../../src/core/modules/file/file-roles.helper';

/**
 * REPRODUCTION — the §16 boot warning cannot see a subclass that re-declares a download handler.
 *
 * This file DOCUMENTS A LIMITATION rather than guarding a property. It is expected to be REWRITTEN,
 * not deleted, when the warning learns to inspect decorator metadata: the last assertion below is
 * the one that would then flip from "silent" to "warns".
 *
 * THE MECHANISM, in three steps that are each individually documented and correct:
 *
 *  1. `applyFileRoles()` writes the configured roles with `Reflect.defineMetadata` onto
 *     `CoreFileController.prototype.getFileById` — the BASE class function, targeted by name.
 *  2. Decorator metadata lives on the FUNCTION OBJECT. A subclass that re-declares the member is a
 *     different function carrying its own `@Roles()`, and it is that function Nest registers. The
 *     framework's configuration never reaches the route. `README.md § Overriding` says exactly this,
 *     and `TusModule` deliberately does the opposite (it writes onto `prototype[member]`, so an
 *     override there IS covered).
 *  3. `warnOnUndecidedFileAccess()` decides purely from CONFIGURATION — `resolveRoles(key,
 *     fileConfig)` — plus whether `checkRights()` was overridden. It never reads handler metadata,
 *     and it has no way to reach the subclass from where it is called (the `CoreFileService`
 *     constructor, which knows nothing about controllers).
 *
 * Put together: the deployment whose download routes are actually open to everyone is precisely the
 * one the warning stays silent about. §16 exists to separate a DECISION from an OMISSION; for a
 * subclassed controller it cannot currently tell either apart from a correct configuration.
 *
 * Seen in two independent consumer projects, in both cases on the download routes.
 */

const rolesOf = (fn: unknown): string[] | undefined => Reflect.getMetadata('roles', fn as object);

/**
 * The shape `README.md § Overriding` calls WRONG — and which nothing at boot reports.
 *
 * Deliberately not decorated with `@Controller()` / `@Get()`: the point is the role metadata on the
 * function, and registering a second file controller would drag the whole module in for nothing.
 */
class ProjectFileController extends CoreFileController {
  @Roles(RoleEnum.S_EVERYONE)
  override async getFileById(...args: Parameters<CoreFileController['getFileById']>) {
    return super.getFileById(...args);
  }
}

describe('warnOnUndecidedFileAccess — subclass blind spot', () => {
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

  it('applies the admin-only default to the BASE handler', () => {
    // Step 1. Nothing configured, so the framework closes the gate to platform admins.
    expect(rolesOf(CoreFileController.prototype.getFileById)).toEqual([RoleEnum.ADMIN]);
  });

  it('but the subclass override keeps its own S_EVERYONE, and that is the registered handler', () => {
    // Step 2. `S_EVERYONE` makes the roles guard return true WITHOUT authenticating, so this route
    // is open to anonymous callers while the configuration says admin-only.
    expect(rolesOf(ProjectFileController.prototype.getFileById)).toEqual([RoleEnum.S_EVERYONE]);
    expect(ProjectFileController.prototype.getFileById).not.toBe(CoreFileController.prototype.getFileById);
  });

  it('and the boot warning stays silent — the exposure is invisible to it', () => {
    // Step 3, and the finding. Every input the warning looks at says "admin-only, nothing to
    // report": no `file.access`, no overridden `checkRights()`, no widened role in the config.
    //
    // CHANGE-DETECTOR BY DESIGN: if the warning is taught to inspect the resolved handler's own
    // metadata, this expectation becomes `expect(message).toContain(...)`. Do not delete the test
    // to make it pass.
    const message = warnOnUndecidedFileAccess({
      fileConfig: undefined,
      hasPerFileRule: false,
      multiTenancyEnabled: false,
    });

    expect(message).toBeUndefined();
  });

  it('warns as soon as the same widening is expressed in CONFIGURATION instead', () => {
    // The contrast that makes the gap unambiguous: identical effective exposure, one line moved
    // from a decorator into config.env.ts, and the warning fires.
    const message = warnOnUndecidedFileAccess({
      fileConfig: { downloadRoles: [RoleEnum.S_EVERYONE] },
      hasPerFileRule: false,
      multiTenancyEnabled: false,
    });

    expect(message).toContain('The file gate is open beyond platform admins');
  });
});
