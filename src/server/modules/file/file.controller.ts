import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import envConfig from '../../../config.env';
import { RESTUser } from '../../../core/common/decorators/rest-user.decorator';
import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { multerRandomFileName } from '../../../core/common/helpers/file.helper';
import { User } from '../user/user.model';
import { FileService } from './file.service';

/**
 * File controller
 */
@Controller('files')
export class FileController {
  /**
   * Include services
   */
  constructor(protected fileService: FileService) {}

  /**
   * Upload files via REST as an alternative to uploading via GraphQL (see file.resolver.ts)
   */
  @Roles(RoleEnum.ADMIN)
  @Post('upload')
  @UseInterceptors(
    FilesInterceptor('files', null, {
      // Automatic storage handling
      // For configuration see https://github.com/expressjs/multer#storage
      storage: diskStorage({
        // Destination for uploaded file
        // If destination is not set file will be buffered and can be processed
        // in the method
        destination: envConfig.staticAssets.path,

        // Generated random file name
        filename: multerRandomFileName(),
      }),
    })
  )
  uploadFiles(@UploadedFiles() files, @Body() fields: any) {
    console.log('Saved file info', JSON.stringify({ files, fields }, null, 2));
  }

  /**
   * Download file
   */
  @Roles(RoleEnum.ADMIN)
  @Get(':filename')
  async getFile(@Param('filename') filename: string, @Res() res, @RESTUser() user: User) {
    if (!filename) {
      throw new BadRequestException('Missing filename for download');
    }

    const file = await this.fileService.getFileInfoByName(filename);
    if (!file) {
      throw new NotFoundException('File not found');
    }
    const filestream = await this.fileService.getFileStream(file.id);
    res.header('Content-Type', file.contentType);
    res.header('Content-Disposition', 'attachment; filename=' + file.filename);
    return filestream.pipe(res);
  }
}
