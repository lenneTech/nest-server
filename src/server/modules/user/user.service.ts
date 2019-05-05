import { Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as fs from 'fs';
import { MongoRepository } from 'typeorm';
import envConfig from '../../../config.env';
import { CoreUserService } from '../../../core/modules/user/core-user.service';
import { User } from './user.model';

/**
 * User service
 */
@Injectable()
export class UserService extends CoreUserService<User> {

  /**
   * User repository
   */
  @InjectRepository(User)
  protected readonly db: MongoRepository<User>;

  /**
   * Set avatar image
   */
  async setAvatar(file: Express.Multer.File, user: User): Promise<string> {

    // Check user
    if (!user) {
      throw new UnauthorizedException();
    }

    // Check file
    if (!file) {
      throw new UnprocessableEntityException('Missing avatar file');
    }

    // Remove old avatar image
    if (user.avatar) {
      fs.unlink(envConfig.staticAssets.path + '/avatars/' + user.avatar, (err) => {
        if (err) {
          console.log(err);
        }
      });
    }

    // Update user
    const result = await this.db.update(user.id.toString(), { avatar: file.filename });

    // Return user
    return file.filename;
  }
}
