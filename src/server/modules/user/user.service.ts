import { EntityRepository, MikroORM } from '@mikro-orm/core';
import { Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import * as fs from 'fs';
import { GraphQLResolveInfo } from 'graphql';
import { PubSub } from 'graphql-subscriptions';
import envConfig from '../../../config.env';
import { FilterArgs } from '../../../core/common/args/filter.args';
import { Filter } from '../../../core/common/helpers/filter.helper';
import { ServiceHelper } from '../../../core/common/helpers/service.helper';
import { ICorePersistenceModel } from '../../../core/common/interfaces/core-persistence-model.interface';
import { ConfigService } from '../../../core/common/services/config.service';
import { EmailService } from '../../../core/common/services/email.service';
import { CoreUserService } from '../../../core/modules/user/core-user.service';
import { UserCreateInput } from './inputs/user-create.input';
import { UserInput } from './inputs/user.input';
import { User } from './user.model';

// Subscription
const pubSub = new PubSub();

/**
 * User service
 */
@Injectable()
export class UserService extends CoreUserService<User, UserInput, UserCreateInput> {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * User repository
   */
  protected readonly db: EntityRepository<User>;

  /**
   * User model
   */
  protected readonly model: ICorePersistenceModel;

  // ===================================================================================================================
  // Injections
  // ===================================================================================================================

  /**
   * Constructor for injecting services
   */
  constructor(
    protected readonly configService: ConfigService,
    protected readonly emailService: EmailService,
    protected readonly orm: MikroORM
  ) {
    super();
    this.db = orm.em.getRepository(User);
    this.model = User;
  }

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Create new user and send welcome email
   */
  async create(input: UserCreateInput, currentUser?: User, ...args: any[]): Promise<User> {
    const user = await super.create(input, currentUser);
    const text = `Welcome ${user.firstName}, this is plain text from server.`;
    await this.emailService.sendMail(user.email, 'Welcome', {
      htmlTemplate: 'welcome',
      templateData: user,
      text,
    });
    return user;
  }

  /**
   * Get users via filter
   */
  find(filterArgs?: FilterArgs, ...args: any[]): Promise<User[]> {
    // Return found users
    return this.db.find(...Filter.convertFilterArgsToQuery(filterArgs));
  }

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
    user.avatar = file.filename;
    await this.db.flush();

    // Return user
    return file.filename;
  }

  // ===================================================================================================================
  // Helper methods
  // ===================================================================================================================

  /**
   * Prepare input before save
   */
  protected async prepareInput(input: { [key: string]: any }, currentUser: User, options: { create?: boolean } = {}) {
    return ServiceHelper.prepareInput(input, currentUser, options);
  }

  /**
   * Prepare output before return
   */
  protected async prepareOutput(user: User, info?: GraphQLResolveInfo) {
    return ServiceHelper.prepareOutput(user, User, this);
  }
}
