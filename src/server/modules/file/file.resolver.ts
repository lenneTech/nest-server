import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { createWriteStream } from 'fs';

import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { FileUpload } from '../../../core/modules/file/interfaces/file-upload.interface';
import { FileService } from './file.service';
import { FileInfo } from './file-info.model';

import fs = require('fs');
import GraphQLUpload = require('graphql-upload/GraphQLUpload.js');

/**
 * File resolver
 */
@Resolver()
@Roles(RoleEnum.ADMIN)
export class FileResolver {
  /**
   * Integrate services
   */
  constructor(protected readonly fileService: FileService) {}

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get file info
   */
  @Roles(RoleEnum.ADMIN)
  @Query(() => FileInfo, { nullable: true })
  async getFileInfo(@Args({ name: 'filename', type: () => String }) filename: string) {
    return await this.fileService.getFileInfoByName(filename);
  }

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Delete file
   */
  @Roles(RoleEnum.ADMIN)
  @Mutation(() => FileInfo)
  async deleteFile(@Args({ name: 'filename', type: () => String }) filename: string) {
    return await this.fileService.deleteFileByName(filename);
  }

  /**
   * Upload file
   */
  @Roles(RoleEnum.ADMIN)
  @Mutation(() => FileInfo)
  async uploadFile(@Args({ name: 'file', type: () => GraphQLUpload }) file: FileUpload) {
    return await this.fileService.createFile(file);
  }

  /**
   * Upload files
   */
  @Roles(RoleEnum.ADMIN)
  @Mutation(() => Boolean)
  async uploadFiles(@Args({ name: 'files', type: () => [GraphQLUpload] }) files: FileUpload[]) {
    // Save files in filesystem
    const promises: Promise<any>[] = [];
    for (const file of files) {
      // eslint-disable-next-line unused-imports/no-unused-vars
      const { createReadStream, encoding, filename, mimetype } = await file;
      await fs.promises.mkdir('./uploads', { recursive: true });
      promises.push(
        new Promise((resolve, reject) =>
          createReadStream()
            .pipe(createWriteStream(`./uploads/${filename}`))
            .on('finish', () => resolve(true))
            .on('error', error => reject(error)),
        ),
      );
    }
    await Promise.allSettled(promises);
    return true;
  }
}
