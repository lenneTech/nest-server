import { Body, Controller, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import envConfig from '../../../config.env';
import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { FileHelper } from '../../../core/common/helpers/file.helper';

/**
 * File controller for
 */
@Controller('files')
export class FileController {

  /**
   * Upload files
   */
  @Roles(RoleEnum.USER)
  @Post('upload')
  @UseInterceptors(FilesInterceptor('files', null, {

    // Automatic storage handling
    // For configuration see https://github.com/expressjs/multer#storage
    storage: diskStorage({

      // Destination for uploaded file
      // If destination is not set file will be buffered and can be processed
      // in the method
      destination: envConfig.staticAssets.path,

      // Generated random file name
      filename: FileHelper.multerRandomFileName(),
    }),
  }))
  uploadFile(@UploadedFiles() files, @Body() fields: any) {
    console.log(files, fields);
  }
}
