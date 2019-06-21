import { Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Controller } from '@nestjs/common/decorators/core/controller.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import envConfig from '../../../config.env';
import { RESTUser } from '../../../core/common/decorators/rest-user.decorator';
import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { FileHelper } from '../../../core/common/helpers/file.helper';
import { User } from './user.model';
import { UserService } from './user.service';

/**
 * Controller for avatar
 */
@Controller('avatar')
export class AvatarController {

  /**
   * Import services
   */
  constructor(private readonly usersService: UserService) {}

  /**
   * Upload files
   */
  @Roles(RoleEnum.USER)
  @Post('upload')
  @UseInterceptors(FileInterceptor('file',
    FileHelper.multerOptionsForImageUpload({
      destination: envConfig.staticAssets.path + '/avatars',
    })))
  uploadFile(@UploadedFile() file: Express.Multer.File, @RESTUser() user: User): Promise<string> {
    return this.usersService.setAvatar(file, user);
  }
}
