import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import * as GraphQLUpload from 'graphql-upload/GraphQLUpload.js';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreFileService } from './core-file.service';
import { CoreFileInfo } from './core-file-info.model';
import { FileUpload } from './interfaces/file-upload.interface';

/**
 * File resolver
 */
@Roles(RoleEnum.ADMIN)
@Resolver()
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
  @Roles(RoleEnum.S_EVERYONE)
  @Query(() => CoreFileInfo, { nullable: true })
  async getFileInfo(@Args({ name: 'filename', type: () => String }) filename: string): Promise<any> {
    return await this.fileService.getFileInfoByName(filename);
  }

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Delete file
   */
  @Roles(RoleEnum.S_EVERYONE)
  @Mutation(() => CoreFileInfo)
  async deleteFile(@Args({ name: 'filename', type: () => String }) filename: string): Promise<any> {
    return await this.fileService.deleteFileByName(filename);
  }

  /**
   * Upload file
   */
  @Roles(RoleEnum.S_EVERYONE)
  @Mutation(() => CoreFileInfo)
  async uploadFile(@Args({ name: 'file', type: () => GraphQLUpload }) file: FileUpload): Promise<any> {
    return await this.fileService.createFile(file);
  }

  /**
   * Upload files
   */
  @Roles(RoleEnum.S_EVERYONE)
  @Mutation(() => [CoreFileInfo])
  async uploadFiles(@Args({ name: 'files', type: () => [GraphQLUpload] }) files: FileUpload[]): Promise<any> {
    return await this.fileService.createFiles(files);
  }
}
