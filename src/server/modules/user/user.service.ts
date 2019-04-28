import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';
import { UserService as CoreUserService } from '../../../core/modules/user/user.service';
import { User } from './user.model';

/**
 * User service
 */
@Injectable()
export class UserService extends CoreUserService(User) {

  /**
   * User repository
   */
  @InjectRepository(User)
  readonly db: MongoRepository<User>;
}
