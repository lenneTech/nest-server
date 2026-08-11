import { Logger, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Controller } from '@nestjs/common/decorators/core/controller.decorator';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentUser } from '../../../core/common/decorators/current-user.decorator';
import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { getStringIds } from '../../../core/common/helpers/db.helper';
import { multerFileToUpload, multerOptionsForImageUpload } from '../../../core/common/helpers/file.helper';
import { FileService } from '../file/file.service';
import { User } from './user.model';
import { UserService } from './user.service';

/**
 * Controller for avatar
 */
@Controller('avatar')
@Roles(RoleEnum.ADMIN)
export class AvatarController {
  protected readonly logger = new Logger(AvatarController.name);

  /**
   * Import services
   */
  constructor(
    protected readonly usersService: UserService,
    protected readonly fileService: FileService,
  ) {}

  /**
   * Upload files
   */
  @Post('upload')
  @Roles(RoleEnum.S_USER)
  @UseInterceptors(
    FileInterceptor(
      'file',
      // `memory: true`, NOT a disk destination: the avatar goes into the central
      // file storage (GridFS/S3) so every replica can serve it and a restart or
      // reschedule does not lose it. A pod-local `staticAssets` path is readable
      // by exactly one replica.
      multerOptionsForImageUpload({ memory: true }),
    ),
  )
  async uploadFile(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: User): Promise<string> {
    // Record the owner. `file.downloadRoles` defaults to ADMIN, so without this the
    // uploader could not fetch their own avatar back — roles answer "may this caller
    // reach the route", never "may this caller have THIS file". FileService.checkRights()
    // reads this metadata to answer the second question.
    const stored = await this.fileService.createFile(multerFileToUpload(file), {
      metadata: { ownerId: getStringIds(user.id) },
    });
    const previousAvatar = await this.usersService.setAvatar(stored.id, user);

    // Drop the replaced file. A failure here must not fail the upload: the new avatar
    // is already stored and referenced, so an orphaned object is a cleanup concern,
    // not a request error.
    if (previousAvatar) {
      try {
        await this.fileService.deleteFile(previousAvatar);
      } catch (error) {
        this.logger.warn(
          `Could not remove previous avatar ${previousAvatar}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    return stored.id;
  }
}
