import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PubSub } from 'graphql-subscriptions';
import { FilterArgs } from '../../common/args/filter.args';
import { RoleEnum } from '../../common/enums/role.enum';
import { Filter } from '../../common/helpers/filter.helper';
import { CoreBasicUserService } from './core-basic-user.service';
import { CoreUserModel } from './core-user.model';
import { CoreUserCreateInput } from './inputs/core-user-create.input';
import { CoreUserInput } from './inputs/core-user.input';
import { Model } from 'mongoose';
import * as _ from 'lodash';
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
  protected constructor(protected readonly userModel: Model<any>, protected emailService: EmailService) {
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

    // Generate verification token
    const newUser = { ...input, ...{ verificationToken: crypto.randomBytes(32).toString('hex') } };

    // Create new user
    const createdUser = new this.userModel(this.model.map(newUser));

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
    await this.prepareOutput(createdUser, args[0]);

    // Inform subscriber
    pubSub.publish('userCreated', { userCreated: createdUser });

    // Return created user
    return createdUser;
  }

  /**
   * Delete user via ID
   */
  async delete(id: string, ...args: any[]): Promise<TUser> {
    // Search user
    let user = await this.userModel.findOne({ _id: id }).exec();

    // Check user
    if (!user) {
      throw new NotFoundException();
    }

    // Delete user
    await this.userModel.deleteOne({ _id: id }).exec();

    user = this.model.map(user);

    // Return deleted user
    return await this.prepareOutput(user, args[0]);
  }

  /**
   * Get user via ID
   */
  async get(id: string, ...args: any[]): Promise<TUser> {
    const user = await this.userModel.findOne({ _id: id }).exec();

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
        return this.prepareOutput(user, args[0]);
      })
    );
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
  async sentResetPasswordMail(email: string): Promise<TUser> {
    const user = await this.userModel.findOne({ email }).exec();

    if (!user) {
      throw new NotFoundException();
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = resetToken;
    await this.userModel.findByIdAndUpdate(user.id, { $set: { passwordResetToken: resetToken } }).exec();

    return user;
  }

  /**
   * Set roles for specified user
   */
  async setRoles(userId: string, roles: string[]): Promise<TUser> {
    // Check roles
    if (!Array.isArray(roles)) {
      throw new BadRequestException('Missing roles');
    }

    // Check roles values
    if (roles.some((role) => typeof role !== 'string')) {
      throw new BadRequestException('roles contains invalid values');
    }

    // Update and return user
    return this.userModel.findByIdAndUpdate(userId, { roles }).exec();
  }

  /**
   * Update user via ID
   */
  async update(id: string, input: TUserInput, currentUser: TUser, ...args: any[]): Promise<TUser> {
    // Check if user exists
    let user = await this.userModel.findOne({ _id: id }).exec();

    if (!user) {
      throw new NotFoundException(`User not found with ID: ${id}`);
    }

    // Prepare input
    await this.prepareInput(input, currentUser);

    // Update
    user.set(input);

    // Save
    await user.save();

    // Map for response
    user = this.model.map(user);

    // Return user
    return await this.prepareOutput(user as TUser, args[0]);
  }

  // ===================================================================================================================
  // Helper methods
  // ===================================================================================================================

  /**
   * Prepare input before save
   */
  protected async prepareInput(
    input: { [key: string]: any },
    currentUser?: TUser,
    options: { [key: string]: any; checkRoles?: boolean; clone?: boolean } = {},
    ...args: any[]
  ) {
    // Configuration
    const config = {
      checkRoles: false,
      clone: false,
      ...options,
    };

    // Clone input
    if (config.clone) {
      input = JSON.parse(JSON.stringify(input));
    }

    // Process roles
    if (input.roles && config.checkRoles && (!currentUser?.hasRole || !currentUser.hasRole(RoleEnum.ADMIN))) {
      if (!(currentUser as any)?.roles) {
        throw new UnauthorizedException('Missing roles of current user');
      } else {
        const allowedRoles = _.intersection(input.roles, (currentUser as any).roles);
        if (allowedRoles.length !== input.roles.length) {
          const missingRoles = _.difference(input.roles, (currentUser as any).roles);
          throw new UnauthorizedException('Current user not allowed setting roles: ' + missingRoles);
        }
        input.roles = allowedRoles;
      }
    }

    // Hash password
    if (input.password) {
      input.password = await bcrypt.hash((input as any).password, 10);
    }

    // Return prepared input
    return input;
  }

  /**
   * Prepare output before return
   */
  protected async prepareOutput(
    user: TUser,
    options: { [key: string]: any; clone?: boolean } = {},
    ...args: any[]
  ): Promise<TUser> {
    // Configuration
    const config = {
      clone: true,
      ...options,
    };

    // Clone user
    if (config.clone) {
      user = JSON.parse(JSON.stringify(user));
    }

    // Remove password if exists
    delete (user as any).password;

    // Remove verification token if exists
    delete (user as any).verificationToken;

    // Remove password reset token if exists
    delete (user as any).passwordResetToken;

    // Return prepared user
    return user;
  }
}
