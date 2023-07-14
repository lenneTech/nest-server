import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import bcrypt = require('bcrypt');
import crypto = require('crypto');
import { sha256 } from 'js-sha256';
import { Document, Model } from 'mongoose';
import { assignPlain, prepareServiceOptionsForCreate } from '../../common/helpers/input.helper';
import { ServiceOptions } from '../../common/interfaces/service-options.interface';
import { ConfigService } from '../../common/services/config.service';
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
> extends CrudService<TUser, TUserCreateInput, TUserInput> {
  protected constructor(
    protected override readonly configService: ConfigService,
    protected readonly emailService: EmailService,
    protected override readonly mainDbModel: Model<TUser & Document>,
    protected override readonly mainModelConstructor: CoreModelConstructor<TUser>
  ) {
    super();
  }

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Create user
   */
  override async create(input: any, serviceOptions?: ServiceOptions): Promise<TUser> {
    serviceOptions = prepareServiceOptionsForCreate(serviceOptions);
    return this.process(
      async (data) => {
        // Create user with verification token
        const currentUserId = serviceOptions?.currentUser?._id;
        const createdUser = new this.mainDbModel({
          ...data.input,
          verificationToken: crypto.randomBytes(32).toString('hex'),
          createdBy: currentUserId,
          updatedBy: currentUserId,
        });

        // Distinguish between different error messages when saving
        try {
          await createdUser.save();
        } catch (error) {
          if (error?.errors?.email?.kind === 'unique') {
            throw new BadRequestException('Email address already in use');
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
    const dbObject = await this.mainDbModel.findOne({ email }).exec();
    if (!dbObject) {
      throw new NotFoundException(`No user found with email: ${email}`);
    }
    return this.process(async () => dbObject, { dbObject, serviceOptions });
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
  async verify(token: string, serviceOptions?: ServiceOptions): Promise<TUser | string> {
    // Get user
    const dbObject = await this.mainDbModel.findOne({ verificationToken: token }).exec();
    if (!dbObject) {
      throw new NotFoundException(`No user found with verify token: ${token}`);
    }

    if (!dbObject.verificationToken) {
      throw new BadRequestException('User has no verification token');
    }

    if (dbObject.verified) {
      return 'User already verified';
    }

    return this.process(
      async () => {
        // Update and return user
        return await assignPlain(dbObject, { verified: true, verifiedAt: new Date() }).save();
      },
      { dbObject, serviceOptions }
    );
  }

  /**
   * Set new password for user with token
   */
  async resetPassword(token: string, newPassword: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    // Get user
    const dbObject = await this.mainDbModel.findOne({ passwordResetToken: token }).exec();
    if (!dbObject) {
      throw new NotFoundException(`No user found with password reset token: ${token}`);
    }

    return this.process(
      async () => {
        // Check if the password was transmitted encrypted
        // If not, the password is encrypted to enable future encrypted and unencrypted transmissions
        if (this.configService.configFastButReadOnly.sha256 && !/^[a-f0-9]{64}$/i.test(newPassword)) {
          newPassword = sha256(newPassword);
        }

        // Update and return user
        return await assignPlain(dbObject, {
          password: await bcrypt.hash(newPassword, 10),
          passwordResetToken: null,
        }).save();
      },
      { dbObject, serviceOptions }
    );
  }

  /**
   * Set password rest token for email
   */
  async setPasswordResetTokenForEmail(email: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    // Get user
    const dbObject = await this.mainDbModel.findOne({ email }).exec();
    if (!dbObject) {
      throw new NotFoundException(`No user found with email: ${email}`);
    }

    return this.process(
      async () => {
        // Set reset token and return
        dbObject.passwordResetToken = crypto.randomBytes(32).toString('hex');

        // Save
        await dbObject.save();

        // Return new user
        return dbObject;
      },
      { dbObject, serviceOptions }
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
      throw new BadRequestException('Roles contains invalid values');
    }

    // Update and return user
    return this.process(
      async () => {
        return await this.mainDbModel.findByIdAndUpdate(userId, { roles }).exec();
      },
      { serviceOptions }
    );
  }
}
