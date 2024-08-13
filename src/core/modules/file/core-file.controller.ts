import { BadRequestException, Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreFileService } from './core-file.service';

/**
 * File controller
 */
@Roles(RoleEnum.ADMIN)
@Controller('files')
export abstract class CoreFileController {
  /**
   * Include services
   */
  protected constructor(protected fileService: CoreFileService) {}

  /**
   * Download file
   */
  @Roles(RoleEnum.S_EVERYONE)
  @Get(':filename')
  async getFile(@Param('filename') filename: string, @Res() res) {
    if (!filename) {
      throw new BadRequestException('Missing filename for download');
    }

    const file = await this.fileService.getFileInfoByName(filename);
    if (!file) {
      throw new NotFoundException('File not found');
    }
    const filestream = await this.fileService.getFileStream(file.id);
    res.header('Content-Type', file.contentType);
    res.header('Content-Disposition', `attachment; filename=${file.filename}`);
    return filestream.pipe(res);
  }
}
