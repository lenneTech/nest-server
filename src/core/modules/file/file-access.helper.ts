/**
 * The four project classes as ONE dial — `file.access`.
 *
 * WHY THIS EXISTS: the per-file rule is the only place a sentence like "…but only their own" can
 * live, because that sentence needs data and no role name carries data. Until 11.35.0 the framework
 * shipped that rule as an `@example` to copy, and the copy went wrong twice in this repository's own
 * history — both times in the permissive direction:
 *
 *  - `if (!options.currentUser) return true` reads as "system-internal call", and is also exactly what
 *    an ANONYMOUS request looks like;
 *  - narrowing only `'id'` / `'filename'` waves `'filterArgs'` through, which hands over a full
 *    inventory of every upload the moment a project surfaces `findFileInfo()`.
 *
 * Neither mistake is careless — both read as correct. That is the argument for a preset: the rule is
 * always the same handful of sentences, so the framework should own them and the project should
 * declare which one it wants.
 *
 * | `file.access`     | project class                                                  |
 * |-------------------|----------------------------------------------------------------|
 * | `'custom'`        | the project writes its own rule — **the default**; the framework abstains entirely |
 * | `'public'`        | open: anyone may read and write, the role gate is the whole policy |
 * | `'authenticated'` | login-restricted: every signed-in user may use every file       |
 * | `'owner'`         | per-user: only the uploader (plus ADMIN)                        |
 * | `'tenant'`        | per-tenant: only within one's own validated tenant (plus ADMIN) |
 *
 * NOTHING CHANGES FOR AN EXISTING PROJECT. `'custom'` is the default and returns `true` for every
 * input, which is byte-for-byte what `CoreFileService.checkRights()` did before. A project that
 * overrides `checkRights()` keeps full control regardless of the setting — the override IS the rule,
 * and the preset never runs.
 *
 * THE DECISION IS A PURE FUNCTION. It takes an already-loaded raw document instead of a service, so
 * every row of the table can be stated in a unit test without a database, and so the service's only
 * remaining job is to decide whether a lookup is needed at all
 * ({@link fileAccessNeedsRawDocument}) — a listing and a write never need one.
 *
 * DELIBERATELY A LEAF: it imports the role enum and nothing else. `file-roles.helper` already had to
 * be split for the same reason (it imports the endpoint classes, which inject `CoreFileService`), and
 * this file is read FROM the service. See `.claude/rules/architecture.md` → "DI Token Placement".
 */
import { RoleEnum } from '../../common/enums/role.enum';

/** Which of the four project classes this deployment is. */
export type FileAccessPreset = 'authenticated' | 'custom' | 'owner' | 'public' | 'tenant';

/** The input types `CoreFileService.checkRights()` distinguishes. */
type CheckInputType = 'file' | 'filename' | 'files' | 'filterArgs' | 'id';

const PRESETS: readonly FileAccessPreset[] = ['authenticated', 'custom', 'owner', 'public', 'tenant'] as const;

/**
 * Which preset a project asked for.
 *
 * An UNKNOWN value resolves to `'owner'`, the strictest of the data-driven presets — never to
 * `'custom'`. A typo (`access: 'onwer'`) means somebody believes they have an ownership rule; giving
 * them "the framework abstains" would confirm that belief and be wrong in the one direction that
 * cannot be noticed from the outside. A too-strict answer surfaces as a 404 on the first request,
 * which is a bug report; a too-permissive one surfaces as an incident.
 *
 * @default 'custom'
 */
export function resolveFileAccessPreset(fileConfig?: { access?: FileAccessPreset }): FileAccessPreset {
  const configured = fileConfig?.access;
  if (configured === undefined || configured === null) {
    return 'custom';
  }
  return PRESETS.includes(configured) ? configured : 'owner';
}

/**
 * Does the decision for this (preset, input type) pair read the stored document?
 *
 * Asked by the service so it can skip the metadata lookup where the answer cannot use it. A write has
 * no document yet, a listing is not about one document, and the two blanket presets answer without
 * looking — loading anyway would add a query per call for nothing.
 */
export function fileAccessNeedsRawDocument(preset: FileAccessPreset, checkInputType?: CheckInputType): boolean {
  if (preset !== 'owner' && preset !== 'tenant') {
    return false;
  }
  return checkInputType === 'id' || checkInputType === 'filename';
}

/**
 * Decide one file access question.
 *
 * @param options.raw the stored metadata document, loaded by the caller when
 *   {@link fileAccessNeedsRawDocument} says so. `null` means "no such file", which must not be
 *   confused with "no restriction".
 * @param options.tenantId the VALIDATED tenant of the current request (`RequestContext.tenantId`),
 *   never a raw header — an unvalidated header would be worse than no tenant at all.
 */
export function decideFileAccess(options: {
  checkInputType?: CheckInputType;
  currentUser?: { hasRole?: (roles: string[]) => boolean; id?: any };
  force?: boolean;
  preset: FileAccessPreset;
  raw?: null | Record<string, any>;
  tenantId?: string;
}): boolean {
  const { checkInputType, currentUser, force, preset, raw, tenantId } = options;

  // A system caller says so explicitly. This is the documented alternative to the
  // `if (!currentUser) return true` shortcut: the exemption is stated at the call site, in the diff,
  // rather than inferred from an absence that an anonymous request produces too.
  if (force) {
    return true;
  }

  // The framework abstains — identical to the pre-11.35.0 base implementation.
  if (preset === 'custom' || preset === 'public') {
    return true;
  }

  if (preset === 'authenticated') {
    // Deliberately independent of the role gate: it still holds when `downloadRoles` is `S_EVERYONE`,
    // which is the case where a project believes the login requirement is somewhere else.
    return !!currentUser?.id;
  }

  // ADMIN is platform authority and is never locked out — the same union the role guards apply.
  if (currentUser?.hasRole?.([RoleEnum.ADMIN])) {
    return true;
  }

  // Writes stay on the coarse role gate (`file.uploadRoles` / `deleteRoles`): an upload has no stored
  // document yet, so there is nothing to compare against. Ownership of the RESULT is established by
  // the metadata the service stamps as it writes.
  if (checkInputType === 'file' || checkInputType === 'files') {
    return true;
  }

  // A LISTING cannot be narrowed by a yes/no answer — this hook is asked once for the whole query,
  // not once per row. Refusing is the only honest answer; a per-user listing is expressed by forcing
  // the filter server-side and passing `force: true`. See CoreFileService.checkRights().
  if (checkInputType === 'filterArgs') {
    return false;
  }

  if (preset === 'owner') {
    // Requiring the field to be PRESENT is load-bearing twice over: without it an owner-less file
    // compares `String(undefined)` with `String(undefined)` and matches, so every unowned file would
    // be readable by every caller whose id is also missing — i.e. by anonymous requests.
    return !!raw?.metadata?.ownerId && String(raw.metadata.ownerId) === String(currentUser?.id);
  }

  // 'tenant': both sides must be present. No tenant in context is a cron job on the HTTP path and an
  // unresolvable header on the WebSocket path; neither may read tenant-scoped bytes.
  return !!tenantId && !!raw?.metadata?.tenantId && String(raw.metadata.tenantId) === String(tenantId);
}
