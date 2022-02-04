import { Inject, Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import * as fs from 'fs';
import { GraphQLResolveInfo } from 'graphql';
import envConfig from '../../../config.env';
import { FilterArgs } from '../../../core/common/args/filter.args';
import { Filter } from '../../../core/common/helpers/filter.helper';
import { ServiceHelper } from '../../../core/common/helpers/service.helper';
import { ConfigService } from '../../../core/common/services/config.service';
import { EmailService } from '../../../core/common/services/email.service';
import { CoreUserService } from '../../../core/modules/user/core-user.service';
import { UserCreateInput } from './inputs/user-create.input';
import { UserInput } from './inputs/user.input';
import { User } from './user.model';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ICorePersistenceModel } from '../../../core/common/interfaces/core-persistence-model.interface';
import { PubSub } from 'graphql-subscriptions';

/**
 * User service
 */
@Injectable()
export class UserService extends CoreUserService<User, UserInput, UserCreateInput> {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

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
    @InjectModel('User') protected readonly userModel: Model<User>,
    @Inject('PUB_SUB') protected readonly pubSub: PubSub
  ) {
    super(userModel, emailService);
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

    await this.prepareOutput(user, args[0]);

    await this.pubSub.publish('userCreated', User.map(user));

    await this.emailService.sendMail(user.email, 'Welcome', {
      htmlTemplate: 'welcome',
      templateData: { name: user.username, link: envConfig.email.verificationLink + '/' + user.verificationToken },
    });

    return user;
  }

  /**
   * Get users via filter
   */
  find(filterArgs?: FilterArgs, ...args: any[]): Promise<User[]> {
    const filterQuery = Filter.convertFilterArgsToQuery(filterArgs);
    // Return found users
    return this.userModel.find(filterQuery[0], null, filterQuery[1]).exec();
  }

  /**
   * Request password reset mail
   *
   * @param email
   */
  async requestPasswordResetMail(email: string): Promise<boolean> {
    const user = await super.sentResetPasswordMail(email);

    await this.emailService.sendMail(user.email, 'Password reset', {
      htmlTemplate: 'password-reset',
      templateData: { name: user.username, link: envConfig.email.passwordResetLink + '/' + user.passwordResetToken },
    });

    return true;
  }

  /**
   * Set avatar image
   */
  async setAvatar(file: Express.Multer.File, user: User): Promise<string> {
    const dbUser = await this.userModel.findOne({ id: user.id }).exec();
    // Check user
    if (!dbUser) {
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
    dbUser.avatar = file.filename;

    await dbUser.save();

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
