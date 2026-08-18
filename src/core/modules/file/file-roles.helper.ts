import { Logger } from '@nestjs/common';

import { IFileConfig } from '../../common/interfaces/server-options.interface';
import { CoreFileController } from './core-file.controller';
import { CoreFileResolver } from './core-file.resolver';
import { FILE_ROLE_MEMBERS, FileEndpointClassName, FileRoleKey, resolveRoles } from './file-roles.config';

const logger = new Logger('CoreFileRoles');

// Re-exported so no import path broke: `FILE_ROLE_DEFAULTS`, the warnings and the key type are part
// of the published API and used to live here. They moved into an import-free leaf because this file
// imports the endpoint classes, which inject CoreFileService — see file-roles.config.ts.
export {
  FILE_ROLE_DEFAULTS,
  FILE_ROLE_MEMBERS,
  resolveRoles,
  warnOnPresignedDownloadsWithRestrictedRoles,
  warnOnUndecidedEffectiveFileAccess,
  warnOnUndecidedFileAccess,
} from './file-roles.config';
export type { FileEndpointClassName, FileRoleKey, ObservedFileHandler } from './file-roles.config';

/**
 * The prototypes the member names in {@link FILE_ROLE_MEMBERS} resolve against.
 *
 * The NAMES live in `file-roles.config.ts` so the boot audit can share them without importing these
 * classes (that import is what makes this file a non-leaf — see the header of `file-roles.config.ts`
 * for the temporal-dead-zone crash it caused). Only the class lookup lives here.
 */
const ENDPOINT_PROTOTYPES: Record<FileEndpointClassName, unknown> = {
  CoreFileController: CoreFileController.prototype,
  CoreFileResolver: CoreFileResolver.prototype,
};

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

  for (const { className, key, method } of FILE_ROLE_MEMBERS) {
    if (!resolved.has(key)) {
      resolved.set(key, resolveRoles(key, config));
    }

    const target = (ENDPOINT_PROTOTYPES[className] as Record<string, unknown>)[method];
    if (typeof target !== 'function') {
      logger.warn(`Cannot apply file.${key}: ${className}.${method} is not a function — skipping.`);
      continue;
    }

    Reflect.defineMetadata('roles', resolved.get(key), target);
  }
}
