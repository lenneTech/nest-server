import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
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
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';

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
    super(userModel);
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

    const verificationToken = crypto.randomBytes(32).toString('hex');
    await this.userModel.findByIdAndUpdate(user.id, { $set: { verificationToken } }).exec();

    await this.emailService.sendMail(user.email, 'Welcome', {
      htmlTemplate: 'welcome',
      templateData: { name: user.username, link: envConfig.email.verificationLink + '/' + verificationToken },
    });

    return user;
  }

  /**
   * Verify user with token
   *
   * @param token
   */
  async verify(token: string): Promise<boolean> {
    const user = await this.userModel.findOne({ verificationToken: token }).exec();

    if (!user) {
      throw new NotFoundException();
    }

    if (!user.verificationToken) {
      throw new Error('User has no token');
    }

    if (user.verified) {
      throw new Error('User already verified');
    }

    await this.userModel.findByIdAndUpdate(user.id, { $set: { verified: true, verificationToken: null } }).exec();

    return true;
  }

  /**
   * Set newpassword for user with token
   *
   * @param token
   * @param newPassword
   */
  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const user = await this.userModel.findOne({ passwordResetToken: token }).exec();

    if (!user) {
      throw new NotFoundException();
    }

    const cryptedPassword = await bcrypt.hash(newPassword, 10);
    await this.userModel
      .findByIdAndUpdate(user.id, { $set: { password: cryptedPassword, passwordResetToken: null } })
      .exec();

    return true;
  }

  /**
   * Request email with password reset link
   *
   * @param email
   */
  async requestPasswordResetMail(email: string): Promise<boolean> {
    const user = await this.userModel.findOne({ email }).exec();

    if (!user) {
      throw new NotFoundException();
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    await this.userModel.findByIdAndUpdate(user.id, { $set: { passwordResetToken: resetToken } }).exec();

    await this.emailService.sendMail(user.email, 'Password reset', {
      htmlTemplate: 'password-reset',
      templateData: { name: user.username, link: envConfig.email.passwordResetLink + '/' + resetToken },
    });

    return true;
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
