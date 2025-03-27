import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import * as GraphQLUpload from 'graphql-upload/GraphQLUpload.js';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreFileInfo } from './core-file-info.model';
import { CoreFileService } from './core-file.service';
import { FileUpload } from './interfaces/file-upload.interface';

/**
 * File resolver
 */
@Resolver()
@Roles(RoleEnum.ADMIN)
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
  @Roles(RoleEnum.S_EVERYONE)
  async getFileInfo(@Args({ name: 'filename', type: () => String }) filename: string): Promise<any> {
    return await this.fileService.getFileInfoByName(filename);
  }

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Delete file
   */
  @Mutation(() => CoreFileInfo)
  @Roles(RoleEnum.S_EVERYONE)
  async deleteFile(@Args({ name: 'filename', type: () => String }) filename: string): Promise<any> {
    return await this.fileService.deleteFileByName(filename);
  }

  /**
   * Upload file
   */
  @Mutation(() => CoreFileInfo)
  @Roles(RoleEnum.S_EVERYONE)
  async uploadFile(@Args({ name: 'file', type: () => GraphQLUpload }) file: FileUpload): Promise<any> {
    return await this.fileService.createFile(file);
  }

  /**
   * Upload files
   */
  @Mutation(() => [CoreFileInfo])
  @Roles(RoleEnum.S_EVERYONE)
  async uploadFiles(@Args({ name: 'files', type: () => [GraphQLUpload] }) files: FileUpload[]): Promise<any> {
    return await this.fileService.createFiles(files);
  }
}
