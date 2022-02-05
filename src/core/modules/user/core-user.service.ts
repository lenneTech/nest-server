import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PubSub } from 'graphql-subscriptions';
import { FilterArgs } from '../../common/args/filter.args';
import { Filter } from '../../common/helpers/filter.helper';
import { ServiceHelper } from '../../common/helpers/service.helper';
import { CoreBasicUserService } from './core-basic-user.service';
import { CoreUserModel } from './core-user.model';
import { CoreUserCreateInput } from './inputs/core-user-create.input';
import { CoreUserInput } from './inputs/core-user.input';
import { Model, Document } from 'mongoose';
import * as crypto from 'crypto';
import envConfig from '../../../config.env';
import { EmailService } from '../../common/services/email.service';

// Subscription
const pubSub = new PubSub();

/**
 * User service
 */
export abstract class CoreUserService<
  TUser extends CoreUserModel,
  TUserInput extends CoreUserInput,
  TUserCreateInput extends CoreUserCreateInput
> extends CoreBasicUserService<TUser, TUserInput, TUserCreateInput> {
  protected constructor(protected readonly userModel: Model<TUser & Document>, protected emailService: EmailService) {
    super(userModel);
  }

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Create user
   */
  async create(input: TUserCreateInput, currentUser?: TUser, ...args: any[]): Promise<TUser> {
    // Prepare input
    await this.prepareInput(input, currentUser, { create: true });

    // Create new user
    const createdUser = new this.userModel({
      ...input,
      verificationToken: crypto.randomBytes(32).toString('hex'),
    });

    try {
      // Save created user
      await createdUser.save();
    } catch (error) {
      if (error.code === 11000) {
        throw new UnprocessableEntityException(`User with email address "${(input as any).email}" already exists`);
      } else {
        throw new UnprocessableEntityException();
      }
    }

    // Prepare output
    const preparedUser = await this.prepareOutput(this.model.map(createdUser), args[0]);

    // Inform subscriber
    pubSub.publish('userCreated', { userCreated: preparedUser });

    // Return created user
    return preparedUser;
  }

  /**
   * Delete user via ID
   */
  async delete(id: string, ...args: any[]): Promise<TUser> {
    // Search user
    const user = await this.userModel.findById(id).exec();

    // Check user
    if (!user) {
      throw new NotFoundException();
    }

    // Delete user
    await user.delete();

    // Prepare output
    const deletedUser = await this.prepareOutput(this.model.map(user), args[0]);

    // Inform subscriber
    pubSub.publish('userDeleted', { userDeleted: deletedUser });

    // Return deleted user
    return deletedUser;
  }

  /**
   * Get user via ID
   */
  async get(id: string, ...args: any[]): Promise<TUser> {
    const user = await this.userModel.findById(id).exec();

    if (!user) {
      throw new NotFoundException();
    }

    return this.prepareOutput(this.model.map(user), args[0]);
  }

  /**
   * Get users via filter
   */
  async find(filterArgs?: FilterArgs, ...args: any[]): Promise<TUser[]> {
    const filterQuery = Filter.convertFilterArgsToQuery(filterArgs);
    // Return found users
    return await Promise.all(
      (
        await this.userModel.find(filterQuery[0], null, filterQuery[1]).exec()
      ).map((user) => {
        return this.prepareOutput(this.model.map(user), args[0]);
      })
    );
  }

  /**
   * Verify user with token
   */
  async verify(token: string, ...args: any[]): Promise<TUser> {
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

    // Update user
    await Object.assign(user, {
      verified: true,
      verificationToken: null,
    }).save();

    // Prepare verified user
    const verifiedUser = this.prepareOutput(this.model.map(user), args[0]);

    // Inform subscriber
    pubSub.publish('userVerified', { userVerified: verifiedUser });

    // Return prepared verified user
    return verifiedUser;
  }

  /**
   * Set newpassword for user with token
   */
  async resetPassword(token: string, newPassword: string, ...args: any[]): Promise<TUser> {
    const user = await this.userModel.findOne({ passwordResetToken: token }).exec();

    if (!user) {
      throw new NotFoundException();
    }

    // Update user
    await Object.assign(user, {
      password: await bcrypt.hash(newPassword, 10),
      passwordResetToken: null,
    }).save();

    // Return prepared user with changed password
    return this.prepareOutput(this.model.map(user), args[0]);
  }

  /**
   * Request email with password reset link
   */
  async sentResetPasswordMail(email: string, ...args: any[]): Promise<TUser> {
    const user = await this.userModel.findOne({ email }).exec();

    if (!user) {
      throw new NotFoundException();
    }

    // Set reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = resetToken;
    await user.save();

    // Send mail
    await this.emailService.sendMail(user.email, 'Password reset', {
      htmlTemplate: 'password-reset',
      templateData: { name: user.username, link: envConfig.email.passwordResetLink + '/' + resetToken },
    });

    // Return user who want to reset the password
    return this.prepareOutput(this.model.map(user), args[0]);
  }

  /**
   * Set roles for specified user
   */
  async setRoles(userId: string, roles: string[], ...args: any[]): Promise<TUser> {
    // Check roles
    if (!Array.isArray(roles)) {
      throw new BadRequestException('Missing roles');
    }

    // Check roles values
    if (roles.some((role) => typeof role !== 'string')) {
      throw new BadRequestException('roles contains invalid values');
    }

    // Update and return user
    const user = await this.userModel.findByIdAndUpdate(userId, { roles }).exec();
    return this.prepareOutput(this.model.map(user), args[0]);
  }

  /**
   * Update user via ID
   */
  async update(id: string, input: TUserInput, currentUser: TUser, ...args: any[]): Promise<TUser> {
    // Check if user exists
    const user = await this.userModel.findById(id).exec();

    if (!user) {
      throw new NotFoundException(`User not found with ID: ${id}`);
    }

    // Prepare input
    await this.prepareInput(input, currentUser);

    // Update
    await Object.assign(user, input).save();

    // Return user
    return await this.prepareOutput(this.model.map(user), args[0]);
  }

  // ===================================================================================================================
  // Helper methods
  // ===================================================================================================================

  /**
   * Prepare input before save
   */
  protected async prepareInput(
    input: Record<string, any>,
    currentUser?: TUser,
    options: { [key: string]: any; checkRoles?: boolean; clone?: boolean } = {},
    ...args: any[]
  ) {
    return ServiceHelper.prepareInput(input, currentUser, options, args);
  }

  /**
   * Prepare output before return
   */
  protected async prepareOutput(
    user: TUser,
    options: { [key: string]: any; clone?: boolean } = {},
    ...args: any[]
  ): Promise<TUser> {
    return ServiceHelper.prepareOutput(user, options);
  }
}
