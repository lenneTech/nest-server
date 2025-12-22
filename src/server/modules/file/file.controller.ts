import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Readable } from 'stream';

import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { CoreFileController } from '../../../core/modules/file/core-file.controller';
import { FileUpload } from '../../../core/modules/file/interfaces/file-upload.interface';
import { FileService } from './file.service';

/**
 * File controller
 *
 * Extends CoreFileController to provide public download endpoints:
 * - GET /files/id/:id - Download file by ID (public)
 * - GET /files/:filename - Download file by filename (public)
 *
 * Adds admin-only endpoints:
 * - POST /files/upload - Upload file (admin)
 * - GET /files/info/:id - Get file info (admin)
 * - DELETE /files/:id - Delete file (admin)
 */
@Controller('files')
@Roles(RoleEnum.ADMIN)
export class FileController extends CoreFileController {
  /**
   * Import services
   */
  constructor(protected override readonly fileService: FileService) {
    super(fileService);
  }

  /**
   * Upload file via HTTP
   */
  @Post('upload')
  @Roles(RoleEnum.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File): Promise<any> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Convert Multer file to FileUpload interface
    const fileUpload: FileUpload = {
      capacitor: null, // Not used when creating from buffer
      createReadStream: () => Readable.from(file.buffer),
      filename: file.originalname,
      mimetype: file.mimetype,
    };

    // Save to GridFS using FileService
    return await this.fileService.createFile(fileUpload);
  }

  /**
   * Get file information
   */
  @Get('info/:id')
  @Roles(RoleEnum.ADMIN)
  async getFileInfo(@Param('id') id: string) {
    return await this.fileService.getFileInfo(id);
  }

  /**
   * Delete file
   */
  @Delete(':id')
  @Roles(RoleEnum.ADMIN)
  async deleteFile(@Param('id') id: string) {
    if (!id) {
      throw new BadRequestException('Missing ID');
    }

    return await this.fileService.deleteFile(id);
  }
}
