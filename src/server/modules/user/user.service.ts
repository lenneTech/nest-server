import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';
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
}
