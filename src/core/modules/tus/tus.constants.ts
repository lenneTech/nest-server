/**
 * Dependency-injection tokens AND cross-file constants of the TUS module.
 *
 * They live in a dedicated, import-free leaf file — never in `tus.module.ts` or a service — so that
 * no file needing a token has to import the module (or vice versa) and close an import cycle.
 *
 * On a cycle, a token read at MODULE-EVALUATION time — inside an `@Inject()` decorator argument, in
 * `design:paramtypes` metadata, or in a static field initializer — reads a `const` still in its
 * temporal dead zone, and SWC-compiled builds (`nest start -b swc`) die at startup with:
 *
 *   ReferenceError: Cannot access 'TUS_CONFIG' before initialization
 *
 * A file that imports nothing can never be mid-evaluation when someone imports it, in any module
 * system, under any compiler. That is the whole point — keep it import-free.
 *
 * `tsc`, `pnpm test` and `oxlint` are all blind to a regression here; only `pnpm run check:swc-tdz`
 * sees it. See .claude/rules/architecture.md → "DI Token Placement (SWC-Safe)".
 */

/**
 * Token for injecting the resolved TUS configuration.
 *
 * Injected type: `Required<ITusConfig>`.
 */
export const TUS_CONFIG = 'TUS_CONFIG';

/**
 * Metadata key recording WHO created a tus upload, in the upload's own (staged) metadata.
 *
 * Framework-owned and ALWAYS overwritten in `onUploadCreate` — metadata otherwise arrives from the
 * client in the `Upload-Metadata` header, so a merged value would let a caller declare somebody else
 * as the owner and hand themselves access to the victim's upload URL.
 *
 * Deliberately NOT `ownerId`: that is the key of the FINISHED FILE's metadata (the one
 * `CoreFileService.checkRights()` documents), and keeping the two distinct means a project's own
 * `ownerId` metadata on a file cannot be confused with the upload-time record.
 *
 * It lives here rather than in the service for the same reason the token above does — and because
 * `tests/unit/import-cycle-invariants.spec.ts` enforces exactly that placement.
 */
export const TUS_OWNER_METADATA_KEY = 'ltOwnerId';

/**
 * Metadata key recording the VALIDATED tenant a tus upload was created in, in the upload's own
 * (staged) metadata. On completion it becomes the finished file's `metadata.tenantId` — the field the
 * file module's `'tenant'` access preset decides on.
 *
 * Framework-owned and ALWAYS overwritten in `onUploadCreate`, exactly like
 * {@link TUS_OWNER_METADATA_KEY}: the client's `Upload-Metadata` header must never be able to place
 * a file in a tenant. It is set only while multi-tenancy is active and the caller's tenant header
 * resolves to a tenant they are an active member of; otherwise it is `null`.
 */
export const TUS_TENANT_METADATA_KEY = 'ltTenantId';
