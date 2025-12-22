import { BadRequestException, Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreFileService } from './core-file.service';

/**
 * File controller
 */
@Controller('files')
@Roles(RoleEnum.ADMIN)
export abstract class CoreFileController {
  /**
   * Include services
   */
  protected constructor(protected fileService: CoreFileService) {}

  /**
   * Download file by ID
   *
   * More reliable than filename-based download as IDs are unique.
   * Recommended for TUS uploads and when filename uniqueness cannot be guaranteed.
   */
  @Get('id/:id')
  @Roles(RoleEnum.S_EVERYONE)
  async getFileById(@Param('id') id: string, @Res() res: Response) {
    if (!id) {
      throw new BadRequestException('Missing file ID for download');
    }

    const file = await this.fileService.getFileInfo(id);
    if (!file) {
      throw new NotFoundException('File not found');
    }
    const filestream = await this.fileService.getFileStream(id);
    res.header('Content-Type', file.contentType || 'application/octet-stream');
    res.header('Content-Disposition', `attachment; filename=${file.filename}`);
    return filestream.pipe(res);
  }

  /**
   * Download file by filename
   *
   * Note: If multiple files have the same filename, only the first match is returned.
   * For unique file access, use GET /files/id/:id instead.
   */
  @Get(':filename')
  @Roles(RoleEnum.S_EVERYONE)
  async getFile(@Param('filename') filename: string, @Res() res: Response) {
    if (!filename) {
      throw new BadRequestException('Missing filename for download');
    }

    const file = await this.fileService.getFileInfoByName(filename);
    if (!file) {
      throw new NotFoundException('File not found');
    }
    const filestream = await this.fileService.getFileStream(file.id);
    res.header('Content-Type', file.contentType || 'application/octet-stream');
    res.header('Content-Disposition', `attachment; filename=${file.filename}`);
    return filestream.pipe(res);
  }
}
