import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import * as GraphQLUpload from 'graphql-upload/GraphQLUpload.js';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { SkipTenantCheck } from '../tenant/core-tenant.decorators';
import { CoreFileInfo } from './core-file-info.model';
import { CoreFileService } from './core-file.service';
import { FileUpload } from './interfaces/file-upload.interface';

/**
 * File resolver
 *
 * SECURITY: gated by `file.downloadRoles` (`getFileInfo`), `file.uploadRoles`
 * (`uploadFile`, `uploadFiles`) and `file.deleteRoles` (`deleteFile`), each
 * defaulting to `[ADMIN]`. The decorators below are the fallback —
 * `CoreModule.forRoot()` rewrites them from config.
 *
 * All four previously carried a handler-level `@Roles(RoleEnum.S_EVERYONE)`,
 * which the roles guard turns into an unconditional `return true` WITHOUT
 * authenticating, defeating the class-level `@Roles(ADMIN)` above (handler and
 * class roles are UNIONed, and `S_EVERYONE` in that union short-circuits).
 * That exposed reads, uploads and DELETES to anonymous callers — but only on a
 * consumer that registers this resolver or a subclass of it: the framework
 * itself registers no `CoreFileModule`, so enabling GraphQL alone did not.
 *
 * TENANT SCOPING: `@SkipTenantCheck()` for the same reason as
 * `CoreFileController` — GridFS is not tenant-scoped, so a role name alone can
 * never express a per-tenant rule. See that class for the full explanation.
 *
 * See `src/core/modules/file/README.md` § Access control.
 */
@Resolver()
@Roles(RoleEnum.ADMIN)
@SkipTenantCheck()
export class CoreFileResolver {
  /**
   * Integrate services
   */
  constructor(protected readonly fileService: CoreFileService) {}

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get file info
   */
  @Query(() => CoreFileInfo, { nullable: true })
  @Roles(RoleEnum.ADMIN)
  async getFileInfo(
    @Args({ name: 'filename', type: () => String }) filename: string,
    @CurrentUser() currentUser?: any,
  ): Promise<any> {
    return await this.fileService.getFileInfoByName(filename, { currentUser });
  }

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Delete file
   */
  @Mutation(() => CoreFileInfo)
  @Roles(RoleEnum.ADMIN)
  async deleteFile(
    @Args({ name: 'filename', type: () => String }) filename: string,
    @CurrentUser() currentUser?: any,
  ): Promise<any> {
    return await this.fileService.deleteFileByName(filename, { currentUser });
  }

  /**
   * Upload file
   */
  @Mutation(() => CoreFileInfo)
  @Roles(RoleEnum.ADMIN)
  async uploadFile(
    @Args({ name: 'file', type: () => GraphQLUpload }) file: FileUpload,
    @CurrentUser() currentUser?: any,
  ): Promise<any> {
    return await this.fileService.createFile(file, { currentUser });
  }

  /**
   * Upload files
   */
  @Mutation(() => [CoreFileInfo])
  @Roles(RoleEnum.ADMIN)
  async uploadFiles(
    @Args({ name: 'files', type: () => [GraphQLUpload] }) files: FileUpload[],
    @CurrentUser() currentUser?: any,
  ): Promise<any> {
    return await this.fileService.createFiles(files, { currentUser });
  }
}
