import { Logger } from '@nestjs/common';

import { RoleEnum } from '../../common/enums/role.enum';
import { IFileConfig } from '../../common/interfaces/server-options.interface';
import { CoreFileController } from './core-file.controller';
import { CoreFileResolver } from './core-file.resolver';

const logger = new Logger('CoreFileRoles');

/**
 * Roles applied when `file` is not configured at all.
 *
 * Restrictive on purpose: one GridFS bucket is shared by every feature of the
 * consuming project, and the ObjectIds naming its blobs are not secrets.
 */
export type FileRoleKey = 'deleteRoles' | 'downloadRoles' | 'uploadRoles';

export const FILE_ROLE_DEFAULTS: Record<FileRoleKey, string[]> = {
  deleteRoles: [RoleEnum.ADMIN],
  downloadRoles: [RoleEnum.ADMIN],
  uploadRoles: [RoleEnum.ADMIN],
};

/**
 * Which member is governed by which knob.
 *
 * `getFileInfo` rides with `downloadRoles` rather than getting its own knob:
 * it answers filename, size and content type for a blob, which is the metadata
 * half of a download. Splitting it would let a project accidentally publish the
 * bucket's contents list while believing downloads were still closed.
 */
const ROLE_TARGETS: { key: FileRoleKey; member: string; owner: () => unknown }[] = [
  {
    key: 'downloadRoles',
    member: 'CoreFileController.getFileById',
    owner: () => CoreFileController.prototype.getFileById,
  },
  { key: 'downloadRoles', member: 'CoreFileController.getFile', owner: () => CoreFileController.prototype.getFile },
  { key: 'downloadRoles', member: 'CoreFileResolver.getFileInfo', owner: () => CoreFileResolver.prototype.getFileInfo },
  { key: 'uploadRoles', member: 'CoreFileResolver.uploadFile', owner: () => CoreFileResolver.prototype.uploadFile },
  { key: 'uploadRoles', member: 'CoreFileResolver.uploadFiles', owner: () => CoreFileResolver.prototype.uploadFiles },
  { key: 'deleteRoles', member: 'CoreFileResolver.deleteFile', owner: () => CoreFileResolver.prototype.deleteFile },
];

/**
 * Resolve one knob to the role list that will actually be applied.
 *
 * An empty array is treated as "not configured". It cannot mean "nobody": the
 * guards read an all-empty role set as "no roles required" and return true, so
 * honouring it literally would OPEN the route instead of closing it — the exact
 * opposite of what someone writing `[]` intends.
 */
function resolveRoles(key: FileRoleKey, config?: IFileConfig): string[] {
  const configured = config?.[key];

  if (configured === undefined) {
    return FILE_ROLE_DEFAULTS[key];
  }

  if (!Array.isArray(configured) || configured.length === 0 || configured.some((role) => typeof role !== 'string')) {
    logger.warn(
      `Ignoring file.${key}: expected a non-empty array of role strings, got ${JSON.stringify(configured)}. ` +
        `Falling back to ${JSON.stringify(FILE_ROLE_DEFAULTS[key])}.`,
    );
    return FILE_ROLE_DEFAULTS[key];
  }

  return configured;
}

/**
 * Apply the configured file roles to the core file endpoints.
 *
 * Uses `Reflect.defineMetadata` rather than `@Roles()` for the same reason
 * `CorePermissionsModule` does: the value is only known at runtime, from the
 * configuration. `RolesGuard` / `BetterAuthRolesGuard` read exactly this key.
 *
 * TWO PROPERTIES A READER SHOULD KNOW ABOUT:
 *
 * 1. **ADMIN always keeps access.** Both classes carry a class-level
 *    `@Roles(RoleEnum.ADMIN)`, and the guards UNION handler and class metadata
 *    (`mergeRolesMetadata`) rather than letting one override the other. So
 *    `downloadRoles: ['editor']` grants editors *in addition to* admins. That is
 *    intended — it keeps a misconfiguration from locking the owner out — but it
 *    does mean these knobs cannot be used to exclude admins.
 *
 * 2. **A subclass that OVERRIDES a member opts out of the configuration.**
 *    Decorator metadata lives on the function object; an override is a different
 *    function, so what this writes onto the base method no longer applies.
 *    Consumers who want config-driven roles must inherit the member rather than
 *    re-declaring it. This is precisely the trap that kept `nest-server-starter`
 *    serving public downloads after the core default had already been closed.
 */
export function applyFileRoles(config?: IFileConfig): void {
  const resolved = new Map<FileRoleKey, string[]>();

  for (const { key, member, owner } of ROLE_TARGETS) {
    if (!resolved.has(key)) {
      resolved.set(key, resolveRoles(key, config));
    }

    const target = owner();
    if (typeof target !== 'function') {
      logger.warn(`Cannot apply file.${key}: ${member} is not a function — skipping.`);
      continue;
    }

    Reflect.defineMetadata('roles', resolved.get(key), target);
  }
}
