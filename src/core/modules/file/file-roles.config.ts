/**
 * File-role CONFIGURATION and the two boot warnings — the half that touches no endpoint class.
 *
 * SPLIT OUT OF `file-roles.helper.ts` because that file imports `CoreFileController` and
 * `CoreFileResolver` (it writes role metadata onto their prototypes), and both of them inject
 * `CoreFileService`. So a service reading a warning from there closes
 *
 *   core-file.service -> file-roles.helper -> core-file.controller -> core-file.service
 *
 * and the controller dereferences `CoreFileService` in `design:paramtypes`, i.e. at CLASS-DEFINITION
 * time. That is the fatal shape: SWC -> CommonJS dies at startup with
 * `Cannot access 'CoreFileService' before initialization`, while tsc, vitest and oxlint all stay
 * green. `pnpm run check:swc-tdz` caught exactly that when the warning was first added here.
 *
 * This file therefore imports only enums and interfaces. See
 * `.claude/rules/architecture.md` -> "DI Token Placement (SWC-Safe)".
 */
import { Logger } from '@nestjs/common';

import { RoleEnum } from '../../common/enums/role.enum';
import { IFileConfig, IS3Config } from '../../common/interfaces/server-options.interface';

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
 * Resolve one knob to the role list that will actually be applied.
 *
 * An empty array is treated as "not configured". It cannot mean "nobody": the
 * guards read an all-empty role set as "no roles required" and return true, so
 * honouring it literally would OPEN the route instead of closing it — the exact
 * opposite of what someone writing `[]` intends.
 */
export function resolveRoles(key: FileRoleKey, config?: IFileConfig): string[] {
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
 * Warn when presigned S3 downloads are combined with a restricted `downloadRoles`.
 *
 * The two settings pull in opposite directions, and the conflict is invisible at the call site:
 *
 * - `downloadRoles` says "only these roles may download this file". It is enforced on every request.
 * - `presignedDownloads` answers `302` with a time-limited S3 URL instead of streaming. That URL is
 *   a BEARER capability — authorized once, at issue time. Whoever holds it afterwards fetches the
 *   object with no session, from any IP, until it expires, and **the grant cannot be revoked in
 *   between**. It survives in browser history, `Referer` headers, proxy logs and chat messages.
 *
 * So the second setting hands out exactly what the first one restricts. That is a sound trade for
 * public assets (which is what presigning is FOR — hence no warning when downloads are
 * `S_EVERYONE`), and almost never what a project means when it has narrowed the roles.
 *
 * A warning rather than a boot failure: unlike an incoherent role vocabulary, this combination has
 * legitimate uses (short expiry, a CDN in front, files whose audience really is "anyone who once
 * held the link"). The operator has to be able to choose it — they just should not choose it by
 * accident.
 */
export function warnOnPresignedDownloadsWithRestrictedRoles(
  s3Config?: IS3Config,
  fileConfig?: IFileConfig,
): string | undefined {
  const presigned = s3Config?.presignedDownloads;
  const presignedEnabled =
    presigned === true || (!!presigned && typeof presigned === 'object' && (presigned as any).enabled !== false);
  if (!presignedEnabled) {
    return undefined;
  }

  const downloadRoles = resolveRoles('downloadRoles', fileConfig);
  // Public downloads are the intended use of presigning — nothing to warn about.
  if (downloadRoles.includes(RoleEnum.S_EVERYONE)) {
    return undefined;
  }

  // Returned as well as logged: the message IS the contract here (an operator has to be able to act
  // on it), and a module-private Logger instance cannot be asserted against from a unit test.
  const message =
    `s3.presignedDownloads is enabled while file.downloadRoles restricts downloads to ` +
    `${JSON.stringify(downloadRoles)}. A presigned URL is a BEARER capability: it is authorized ` +
    `once, at issue time, and afterwards anyone holding it can fetch the object with no session, ` +
    `from any IP, until it expires — the grant cannot be revoked in between, and it survives in ` +
    `browser history, Referer headers and proxy logs. The role check therefore applies to ` +
    `obtaining the link, not to reading the file. If these files are sensitive (personal or ` +
    `medical data), set s3.presignedDownloads: false so the API streams them and re-checks ` +
    `rights on every request.`;

  logger.warn(message);
  return message;
}

/**
 * Warn when a MULTI-TENANT project widens the file gate past platform admins without a per-file rule.
 *
 * THE GAP THIS NAMES: the file stores are not tenant-scoped and cannot be. GridFS, `s3-files` and
 * `filesystem-files` are reached through the native MongoDB driver or through S3, so
 * `mongooseTenantPlugin` never runs on them — which is also why `CoreFileController` and
 * `CoreFileResolver` carry `@SkipTenantCheck()`. Consequently the role names in `file.downloadRoles` /
 * `uploadRoles` / `deleteRoles` are resolved against `user.roles`, a GLOBAL attribute, never against
 * `membership.role`. A user holding `'editor'` in `user.roles` can therefore reach EVERY tenant's
 * files, and no configuration can express "…but only their own tenant's": that sentence needs data, and
 * the only place it can live is `CoreFileService.checkRights()`.
 *
 * WHY THE CONDITIONS ARE THIS NARROW — a warning nobody can act on is noise, and noise gets muted:
 *
 * - `multiTenancy` off → no tenant boundary exists to cross. Silent.
 * - Every knob still `[ADMIN]` (the default) → only platform admins reach the routes at all, and
 *   platform admins legitimately see every tenant. Silent.
 * - `checkRights()` overridden → the project HAS a per-file rule. Whether it is a good one is beyond
 *   what a boot check can know; the framework's job is to notice the absence, not to grade it. Silent.
 *
 * That leaves exactly one case: multi-tenancy is on, the gate has been opened to a non-admin role, and
 * nothing anywhere narrows it per file. Then the deployment has a file store every holder of that role
 * can read across tenants, and it is very unlikely anyone decided that on purpose.
 *
 * A warning, not a boot failure. The framework cannot know whether the files are patient documents or
 * public logos, and refusing to start on a configuration that is correct for the second would be
 * wrong. What it can do is refuse to be silent.
 *
 * @param hasPerFileRule whether `CoreFileService.checkRights()` is overridden — the caller knows,
 *   because it has the instance; this helper stays a pure function so it can be unit-tested.
 * @returns the message, or `undefined` when there is nothing to warn about. Returned as well as
 *   logged for the same reason as {@link warnOnPresignedDownloadsWithRestrictedRoles}: the message IS
 *   the contract, and a module-private Logger cannot be asserted against.
 */
export function warnOnUnscopedFilesInTenantMode(options: {
  fileConfig?: IFileConfig;
  hasPerFileRule: boolean;
  multiTenancyEnabled: boolean;
}): string | undefined {
  const { fileConfig, hasPerFileRule, multiTenancyEnabled } = options;
  if (!multiTenancyEnabled || hasPerFileRule) {
    return undefined;
  }

  const widened: string[] = [];
  for (const key of ['deleteRoles', 'downloadRoles', 'uploadRoles'] as FileRoleKey[]) {
    const roles = resolveRoles(key, fileConfig);
    // ADMIN is unioned in by the class-level decorator regardless, so it never widens anything.
    if (roles.some((role) => role !== RoleEnum.ADMIN)) {
      widened.push(`file.${key}=${JSON.stringify(roles)}`);
    }
  }
  if (!widened.length) {
    return undefined;
  }

  const message =
    `multiTenancy is active and the file gate is open beyond platform admins (${widened.join(', ')}), ` +
    `but CoreFileService.checkRights() is NOT overridden. The file stores are reached outside Mongoose, ` +
    `so mongooseTenantPlugin never scopes them and these role names resolve against user.roles — a ` +
    `GLOBAL attribute — never against membership.role. Every holder of such a role can therefore read, ` +
    `overwrite or delete EVERY tenant's files. A role name cannot express "only their own tenant": ` +
    `write tenantId into the file metadata at upload time (serviceOptions.metadata) and compare it in ` +
    `an overridden checkRights() — see src/core/modules/file/README.md § Access control.`;

  logger.warn(message);
  return message;
}
