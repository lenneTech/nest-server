import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Document, Model } from 'mongoose';
import { merge } from '../../common/helpers/config.helper';
import { ServiceOptions } from '../../common/interfaces/service-options.interface';
import { CrudService } from '../../common/services/crud.service';
import { EmailService } from '../../common/services/email.service';
import { CoreModelConstructor } from '../../common/types/core-model-constructor.type';
import { CoreUserModel } from './core-user.model';
import { CoreUserCreateInput } from './inputs/core-user-create.input';
import { CoreUserInput } from './inputs/core-user.input';

/**
 * User service
 */
export abstract class CoreUserService<
  TUser extends CoreUserModel,
  TUserInput extends CoreUserInput,
  TUserCreateInput extends CoreUserCreateInput
> extends CrudService<TUser> {
  protected constructor(
    protected emailService: EmailService,
    protected readonly mainDbModel: Model<TUser & Document>,
    protected mainModelConstructor: CoreModelConstructor<TUser>
  ) {
    super();
  }

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Create user
   */
  async create(input: any, serviceOptions?: ServiceOptions): Promise<TUser> {
    merge({ prepareInput: { create: true } }, serviceOptions);
    return this.process(
      async (data) => {
        // Create user with verification token
        const createdUser = new this.mainDbModel({
          ...data.input,
          verificationToken: crypto.randomBytes(32).toString('hex'),
        });

        // Distinguish between different error messages when saving
        try {
          await createdUser.save();
        } catch (error) {
          if (error.code === 11000) {
            throw new UnprocessableEntityException(
              `User with email address "${(data.input as any).email}" already exists`
            );
          } else {
            throw new UnprocessableEntityException();
          }
        }

        // Return created user
        return createdUser;
      },
      { input, serviceOptions }
    );
  }

  /**
   * Get user via email
   */
  async getViaEmail(email: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    return this.process(
      async () => {
        const user = await this.mainDbModel.findOne({ email }).exec();
        if (!user) {
          throw new NotFoundException(`No user found with email: ${email}`);
        }
        return user;
      },
      { serviceOptions }
    );
  }

  /**
   * Get verified state of user by token
   */
  async getVerifiedState(token: string, serviceOptions?: ServiceOptions): Promise<boolean> {
    const user = await this.mainDbModel.findOne({ verificationToken: token }).exec();

    if (!user) {
      throw new NotFoundException(`No user found with verify token: ${token}`);
    }

    return user.verified;
  }

  /**
   * Verify user with token
   */
  async verify(token: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    return this.process(
      async () => {
        // Get user
        const user = await this.mainDbModel.findOne({ verificationToken: token }).exec();
        if (!user) {
          throw new NotFoundException(`No user found with verify token: ${token}`);
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

        // Return prepared user
        return user;
      },
      { serviceOptions }
    );
  }

  /**
   * Set newpassword for user with token
   */
  async resetPassword(token: string, newPassword: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    return this.process(
      async () => {
        // Get user
        const user = await this.mainDbModel.findOne({ passwordResetToken: token }).exec();
        if (!user) {
          throw new NotFoundException(`No user found with password reset token: ${token}`);
        }

        // Update user
        await Object.assign(user, {
          password: await bcrypt.hash(newPassword, 10),
          passwordResetToken: null,
        }).save();

        // Return user
        return user;
      },
      { serviceOptions }
    );
  }

  /**
   * Set password rest token for email
   */
  async setPasswordResetTokenForEmail(email: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    return this.process(
      async () => {
        // Get user
        const user = await this.mainDbModel.findOne({ email }).exec();
        if (!user) {
          throw new NotFoundException(`No user found with email: ${email}`);
        }

        // Set reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        user.passwordResetToken = resetToken;
        await user.save();

        // Return user
        return user;
      },
      { serviceOptions }
    );
  }

  /**
   * Set roles for specified user
   */
  async setRoles(userId: string, roles: string[], serviceOptions?: ServiceOptions): Promise<TUser> {
    // Check roles
    if (!Array.isArray(roles)) {
      throw new BadRequestException('Missing roles');
    }

    // Check roles values
    if (roles.some((role) => typeof role !== 'string')) {
      throw new BadRequestException('roles contains invalid values');
    }

    // Update and return user
    return this.process(
      async (data) => {
        return await this.mainDbModel.findByIdAndUpdate(userId, { roles }).exec();
      },
      { serviceOptions }
    );
  }
}
