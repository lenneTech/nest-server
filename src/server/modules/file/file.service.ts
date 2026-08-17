import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { RoleEnum } from '../../../core/common/enums/role.enum';
import { ConfigService } from '../../../core/common/services/config.service';
import { CoreS3Service } from '../../../core/common/services/core-s3.service';
import { CoreFileInfo } from '../../../core/modules/file/core-file-info.model';
import { CoreFileService, FileInputCheckType } from '../../../core/modules/file/core-file.service';
import { FileServiceOptions } from '../../../core/modules/file/interfaces/file-service-options.interface';

/**
 * File service
 */
@Injectable()
export class FileService extends CoreFileService {
  constructor(
    @InjectConnection() protected override readonly connection: Connection,
    protected readonly configService: ConfigService,
    @Optional() protected readonly s3Service?: CoreS3Service,
  ) {
    super(connection, 'fs', { configService, s3Service });
  }

  /**
   * Duplicate file by name.
   *
   * Delegates instead of reaching into `this.files` directly. The direct GridFS
   * pipe this used to be was wrong in four separate ways, and every one of them
   * is the kind of thing a consuming project copies out of here:
   *
   * - it only ever worked on the GridFS driver — under `file.storage: 's3'` or
   *   `'filesystem'` the source is simply not in the bucket;
   * - it bypassed `checkRights()` entirely, so the owner rule below did not apply
   *   to a duplicate at all;
   * - it returned the write stream without awaiting it, so the caller was told the
   *   copy existed while it was still being written;
   * - neither stream carried an error handler, and an unhandled stream `'error'`
   *   takes the whole process down.
   *
   * `duplicateByName()` answers all four. Forward the caller's context so the
   * duplicate is COVERED by the ownership rule rather than exempt from it.
   */
  async duplicate(fileName: string, newName: string, serviceOptions?: FileServiceOptions): Promise<CoreFileInfo> {
    return this.duplicateByName(fileName, newName, serviceOptions);
  }

  /**
   * Per-file authorization for the two inherited download routes.
   *
   * THIS IS DELIBERATELY EXECUTED CODE, NOT AN ILLUSTRATION. It used to be a
   * commented-out `@example` here, on the reasoning that `file.downloadRoles`
   * defaults to `[ADMIN]`, the roles guard therefore answers before the service
   * is reached, and a rule that cannot fire is worse than none. The reasoning was
   * locally sound and globally harmful: a comment is never compiled, never
   * type-checked and never run, so nothing in this repository exercised the
   * `Core*` inheritance seam that every consuming project depends on — and a
   * `deleteFileByName()` bug that dropped `serviceOptions` on the way to its
   * inner lookup shipped green through 2777 tests, to be found downstream hours
   * after release. The commented example was itself wrong (it allowed on a
   * missing `currentUser`), and it was copied verbatim.
   *
   * The tension is resolved the other way round now: `config.env.ts` widens the
   * coarse gate to `[RoleEnum.S_USER]` in every environment, which is what real
   * projects do, so the rule below actually runs on every download this server
   * serves.
   *
   * The rule: ADMIN sees everything; everyone else sees only files whose
   * `metadata.ownerId` is their own id. `AvatarController` writes that metadata
   * at upload time. A file with NO owner recorded — the admin uploads via
   * `/files/upload` and the GraphQL mutations, and TUS uploads, which carry
   * `tusUploadId` but no owner — is therefore ADMIN-only.
   *
   * Two properties worth knowing:
   *
   * - **A refusal answers 404, not 403.** That is the framework's doing, not
   *   this method's: returning `false` makes the caller answer as if the file
   *   did not exist, because a 403 would confirm that the id names a real file
   *   and turn the endpoint into an existence oracle.
   * - **A missing `currentUser` DENIES.** This is the one part that is easy to
   *   get backwards. "No user in context" is NOT "system-internal call" — it is
   *   also exactly what an ANONYMOUS request looks like. Today the coarse gate
   *   turns those away before this hook runs, so an `if (!options.currentUser)
   *   return true` shortcut looks harmless; widen `downloadRoles` to
   *   `S_EVERYONE` and the same branch hands every file to everyone, so the
   *   ownership rule evaporates precisely when it starts to matter. Genuinely
   *   internal callers say so instead: `FileController` / `FileResolver` pass
   *   `{ force: true }` because their `@Roles(ADMIN)` already decided, and
   *   `AvatarController` passes the real `{ currentUser }` so its cleanup delete
   *   is COVERED by this rule rather than exempt from it.
   *
   * BOTH the `id` and the `filename` branch are covered. Covering only `id` is
   * enough while bytes are streamed, because the filename route resolves an id
   * and checks it again — but not once `s3.presignedDownloads` is enabled, where
   * the filename route authorizes on the by-name lookup alone and then redirects.
   * The by-name half is also where the shipped `deleteFileByName()` bug lived.
   *
   * See `src/core/modules/file/README.md` § Access control, and
   * `tests/file-ownership.e2e-spec.ts` for the end-to-end contract test.
   */
  /**
   * NOTE FOR CONSUMERS: since 11.35.0 you may not need any of this.
   *
   * `file.access: 'owner'` is exactly the rule below, shipped by the framework — including the parts
   * that are easy to get wrong (fail closed without a user, require the owner field to be PRESENT,
   * cover the by-name branch, refuse a listing) and including the metadata stamping, which this project
   * does by hand in `AvatarController`. `'tenant'` is the same rule against
   * `metadata.tenantId` and the validated `RequestContext` tenant.
   *
   * This override stays because the reference server has to EXERCISE the seam — a rule that lives only
   * in a preset proves the preset works, never that the inheritance point a consuming project extends
   * still does. Keep it here; in your own project, prefer the preset unless your rights are something
   * the framework cannot guess (an explicit read right, a case assignment, a published flag).
   */
  protected override async checkRights(
    input: any,
    options?: FileServiceOptions & { checkInputType: FileInputCheckType },
  ): Promise<boolean> {
    // Forced (system) calls and WRITES stay on the coarse role gate. Writes deliberately so: an
    // upload has no owner to compare against yet — `AvatarController` records `metadata.ownerId` as
    // it writes — so the only meaningful gate there is `file.uploadRoles`.
    if (options?.force || options?.checkInputType === 'file' || options?.checkInputType === 'files') {
      return true;
    }

    if (options.currentUser?.hasRole?.([RoleEnum.ADMIN])) {
      return true;
    }

    // A LISTING cannot be narrowed by this hook, so it is refused rather than waved through.
    //
    // The hook is asked ONCE for the whole query, not once per row, so there is no answer here that
    // means "…but only their own files". Returning `true` — which this rule used to do, and which is
    // therefore the shape projects copied — hands a non-admin a full inventory of every upload the
    // moment a project surfaces `findFileInfo()`: `CoreFileInfo` carries `filename`, `length`,
    // `uploadDate` and the `id`, and for medical data the filename frequently IS the content.
    //
    // A project that wants "my files" FORCES the constraint server-side and passes `force: true`:
    //
    //   this.fileService.findFileInfo(
    //     { filterQuery: { 'metadata.ownerId': String(currentUser.id) } },
    //     { force: true },
    //   );
    //
    // Note what that is NOT: it does not inspect the caller's `filterArgs` to check whether they are
    // already narrowed. `filterArgs` is CLIENT-CONTROLLED, so approving a filter shape means
    // validating attacker input — and any such check is one filter shape away from being wrong.
    // Override the filter; never approve it. See tests/file-ownership.e2e-spec.ts.
    // Explicit, even though falling through would ALSO deny: with `checkInputType: 'filterArgs'` the
    // `input` is a FilterArgs object, so the by-name raw lookup below answers null and the comparison
    // fails. That is an accident of the fall-through, not a decision — it would flip the moment a
    // project's own raw lookup behaved differently for a non-string input. Say it outright instead.
    if (options.checkInputType === 'filterArgs') {
      return false;
    }

    // The RAW document on purpose: the public getFileInfo() runs prepareOutput(), which
    // strips `metadata` — the very field this decision rests on.
    const raw =
      options.checkInputType === 'id' ? await this.getRawFileInfo(input) : await this.getRawFileInfoByName(input);

    // Fails closed on a missing user: `String(undefined)` can never equal a real owner id.
    // Requiring `metadata.ownerId` to be PRESENT is load-bearing too — without it an
    // owner-less file would compare `String(undefined)` against `String(undefined)` and match.
    return !!raw?.metadata?.ownerId && String(raw.metadata.ownerId) === String(options.currentUser?.id);
  }
}
