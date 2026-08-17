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
 * Warn when the file gate is open and NOTHING decides the per-file policy.
 *
 * THE GAP: the role knobs are a coarse audience filter — they answer "may this caller reach the route
 * at all". They cannot express "…but only their own", because that sentence needs data. So a deployment
 * that widened the gate past platform admins and expressed no per-file policy anywhere has a store
 * every holder of that role can read in full.
 *
 * And that is practically reachable, not theoretically: file ids are ENUMERABLE. An ObjectId is 4 bytes
 * of timestamp + 5 bytes of randomness generated once PER PROCESS + a 3-byte incrementing counter, so a
 * caller who obtains one valid id — their own upload — knows the random part and a counter reference
 * point, and neighbouring files sit on neighbouring values. Nothing rate-limits the file routes either.
 *
 * WHY THE CONDITIONS ARE THIS NARROW — a warning that fires on a correct configuration gets muted, and
 * a muted warning is worse than none. So every way of DECIDING silences it, and all three are
 * legitimate:
 *
 *  1. `file.access` names a project class (`'public'`, `'authenticated'`, `'owner'`, `'tenant'`);
 *  2. `checkRights()` is overridden — the project wrote its own rule, and grading it is beyond what a
 *     boot check can do;
 *  3. the gate is still admin-only — a platform admin legitimately sees everything.
 *
 * That leaves exactly one case: the gate is open and nothing says what the policy is. This warning is
 * about the difference between a DECISION and an OMISSION, which is the only thing a boot check can
 * usefully detect.
 *
 * Multi-tenancy changes only the WORDING. An earlier version of this warning fired only for tenant
 * projects, which was too narrow: `downloadRoles: [S_USER]` with no rule leaks every file to every
 * signed-in user whether or not tenants exist. Where tenants DO exist, the leak also crosses that
 * boundary, and that sentence has to appear — the file stores are reached outside Mongoose, so
 * `mongooseTenantPlugin` never scopes them and these role names resolve against `user.roles`, a GLOBAL
 * attribute.
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
export function warnOnUndecidedFileAccess(options: {
  fileConfig?: IFileConfig;
  hasPerFileRule: boolean;
  multiTenancyEnabled: boolean;
}): string | undefined {
  const { fileConfig, hasPerFileRule, multiTenancyEnabled } = options;

  // (1) and (2): somebody decided.
  if (hasPerFileRule || (fileConfig?.access && fileConfig.access !== 'custom')) {
    return undefined;
  }

  // (3): admin-only. ADMIN is unioned in by the class-level decorator regardless, so it never widens.
  const widened: string[] = [];
  for (const key of ['deleteRoles', 'downloadRoles', 'uploadRoles'] as FileRoleKey[]) {
    const roles = resolveRoles(key, fileConfig);
    if (roles.some((role) => role !== RoleEnum.ADMIN)) {
      widened.push(`file.${key}=${JSON.stringify(roles)}`);
    }
  }
  if (!widened.length) {
    return undefined;
  }

  const tenantNote = multiTenancyEnabled
    ? ' multiTenancy is active, and the leak crosses tenants too: the file stores are reached outside ' +
      'Mongoose, so mongooseTenantPlugin never scopes them and these role names resolve against ' +
      'user.roles — a GLOBAL attribute — never against membership.role.'
    : '';

  const message =
    `The file gate is open beyond platform admins (${widened.join(', ')}), but no per-file policy is ` +
    `declared: file.access is unset and CoreFileService.checkRights() is not overridden. Every holder ` +
    `of such a role can therefore read, overwrite or delete EVERY file — and file ids are not secret, ` +
    `they are ENUMERABLE (an ObjectId shares a per-process random part and an incrementing counter, so ` +
    `one own upload reveals the neighbourhood), with no rate limit on the file routes.${tenantNote} ` +
    `Declare the project class with file.access ('public' | 'authenticated' | 'owner' | 'tenant'), or ` +
    `override checkRights() — see src/core/modules/file/README.md § Access control.`;

  logger.warn(message);
  return message;
}
