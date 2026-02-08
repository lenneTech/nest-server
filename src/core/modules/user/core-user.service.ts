import { BadRequestException, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
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
import { CoreUserServiceOptions } from './interfaces/core-user-service-options.interface';

/**
 * User service
 *
 * Provides user management with automatic synchronization between
 * Legacy Auth and Better-Auth (IAM) systems when both are enabled.
 */
export abstract class CoreUserService<
  TUser extends CoreUserModel,
  TUserInput extends CoreUserInput,
  TUserCreateInput extends CoreUserCreateInput,
> extends CrudService<TUser, TUserCreateInput, TUserInput> {
  protected readonly userServiceLogger = new Logger(CoreUserService.name);

  protected constructor(
    protected override readonly configService: ConfigService,
    protected readonly emailService: EmailService,
    protected override readonly mainDbModel: Model<Document & TUser>,
    protected override readonly mainModelConstructor: CoreModelConstructor<TUser>,
    /**
     * Optional configuration for additional features like IAM sync.
     * Using options object pattern for extensibility without breaking changes.
     */
    protected readonly options?: CoreUserServiceOptions,
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
          createdBy: currentUserId,
          updatedBy: currentUserId,
          verificationToken: crypto.randomBytes(32).toString('hex'),
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
      { input, serviceOptions },
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
   * Get user by MongoDB ID or BetterAuth IAM ID
   *
   * This method is used by RolesGuard to resolve users from BetterAuth JWT tokens.
   * The sub claim in BetterAuth JWTs can contain either:
   * - The MongoDB _id of the user
   * - The BetterAuth iamId
   *
   * @param idOrIamId - MongoDB _id or BetterAuth iamId
   * @returns User object or null if not found
   */
  async getByIdOrIamId(idOrIamId: string): Promise<null | TUser> {
    try {
      // First, try to find by MongoDB _id
      const byId = await this.mainDbModel.findById(idOrIamId).exec();
      if (byId) {
        return byId as TUser;
      }
    } catch {
      // Invalid ObjectId format - try iamId instead
    }

    // Try to find by iamId
    const byIamId = await this.mainDbModel.findOne({ iamId: idOrIamId }).exec();
    return byIamId as null | TUser;
  }

  /**
   * Get verified state of user by token
   */
  async getVerifiedState(token: string, _serviceOptions?: ServiceOptions): Promise<boolean> {
    const user = await this.mainDbModel.findOne({ verificationToken: token }).exec();

    if (!user) {
      throw new NotFoundException(`No user found with verify token: ${token}`);
    }

    return user.verified;
  }

  /**
   * Verify user with token
   */
  async verify(token: string, serviceOptions?: ServiceOptions): Promise<string | TUser> {
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
        await this.mainDbModel.updateOne({ _id: dbObject.id }, { verified: true, verifiedAt: new Date() }).exec();
        // Return the updated user
        return await this.mainDbModel.findById(dbObject.id).exec();
      },
      { dbObject, serviceOptions },
    );
  }

  /**
   * Set new password for user with token
   *
   * This method also syncs the password change to Better-Auth (IAM) if:
   * - BetterAuthUserMapper is configured via options
   * - User has an existing IAM credential account
   */
  async resetPassword(token: string, newPassword: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    // Get user
    const dbObject = await this.mainDbModel.findOne({ passwordResetToken: token }).exec();
    if (!dbObject) {
      throw new NotFoundException(`No user found with password reset token: ${token}`);
    }

    // Store the original plain password for IAM sync before any hashing
    // We need the plain password because IAM uses scrypt, not bcrypt+sha256
    const plainPasswordForIamSync = /^[a-f0-9]{64}$/i.test(newPassword) ? undefined : newPassword;

    return this.process(
      async () => {
        // Check if the password was transmitted encrypted
        // If not, the password is encrypted to enable future encrypted and unencrypted transmissions
        if (this.configService.configFastButReadOnly.sha256 && !/^[a-f0-9]{64}$/i.test(newPassword)) {
          newPassword = sha256(newPassword);
        }

        // Update Legacy Auth password
        const updatedUser = await assignPlain(dbObject, {
          password: await bcrypt.hash(newPassword, 10),
          passwordResetToken: null,
        }).save();

        // Sync password to Better-Auth (IAM) if mapper is available
        // This ensures users can sign in via IAM after password reset
        if (this.options?.betterAuthUserMapper && plainPasswordForIamSync && dbObject.email) {
          try {
            await this.options.betterAuthUserMapper.syncPasswordChangeToIam(dbObject.email, plainPasswordForIamSync);
          } catch (error) {
            // Log but don't fail - Legacy Auth password was updated successfully
            this.userServiceLogger.warn(
              `Failed to sync password reset to IAM for ${dbObject.email}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }

        return updatedUser;
      },
      { dbObject, serviceOptions },
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
      { dbObject, serviceOptions },
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
      { serviceOptions },
    );
  }

  // ===================================================================================================================
  // Auth System Sync Methods
  // ===================================================================================================================

  /**
   * Update user with automatic email and password sync between Legacy and IAM auth systems
   *
   * When the email changes and BetterAuthUserMapper is available, this method:
   * - Invalidates all Better-Auth sessions (forces re-authentication)
   * - The shared users collection is automatically updated
   *
   * When the password changes:
   * - Updates the Legacy Auth password (bcrypt hash)
   * - Syncs to Better-Auth (IAM) if the user has a credential account
   */
  override async update(id: string, input: TUserInput, serviceOptions?: ServiceOptions): Promise<TUser> {
    // Get the current user before update to detect email changes
    const oldUser = (await this.mainDbModel.findById(id).lean().exec()) as null | TUser;
    const oldEmail = oldUser?.email;

    // Store plain password for IAM sync before any hashing occurs
    // We need to capture this before super.update() which may hash it
    const inputPassword = (input as any).password;
    const plainPasswordForIamSync = inputPassword && !/^[a-f0-9]{64}$/i.test(inputPassword) ? inputPassword : undefined;

    // Perform the update
    const updatedUser = await super.update(id, input, serviceOptions);

    // Sync email change to IAM if email was changed and mapper is available
    if (this.options?.betterAuthUserMapper && oldEmail && input.email && oldEmail !== input.email) {
      try {
        await this.options.betterAuthUserMapper.syncEmailChangeFromLegacy(oldEmail, input.email);
        this.userServiceLogger.debug(`Synced email change from Legacy to IAM: ${oldEmail} → ${input.email}`);
      } catch (error) {
        this.userServiceLogger.error(
          `Failed to sync email change to IAM: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        // Don't throw - email sync failure shouldn't block the update
      }
    }

    // Sync password change to IAM if password was changed and mapper is available
    if (this.options?.betterAuthUserMapper && plainPasswordForIamSync && oldUser?.email) {
      try {
        await this.options.betterAuthUserMapper.syncPasswordChangeToIam(oldUser.email, plainPasswordForIamSync);
        this.userServiceLogger.debug(`Synced password change to IAM for user ${oldUser.email}`);
      } catch (error) {
        this.userServiceLogger.warn(
          `Failed to sync password change to IAM for ${oldUser.email}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        // Don't throw - password sync failure shouldn't block the update
      }
    }

    return updatedUser;
  }

  /**
   * Delete user with automatic cleanup of IAM auth data
   *
   * When BetterAuthUserMapper is available, this method also:
   * - Deletes all Better-Auth accounts for this user
   * - Deletes all Better-Auth sessions for this user
   *
   * This ensures no orphaned auth data remains after user deletion.
   */
  override async delete(id: string, serviceOptions?: ServiceOptions): Promise<TUser> {
    // Get the user before deletion to cleanup IAM data
    const user = (await this.mainDbModel.findById(id).lean().exec()) as null | (TUser & { _id: any });

    // Perform the deletion
    const deletedUser = await super.delete(id, serviceOptions);

    // Cleanup IAM data if mapper is available
    if (this.options?.betterAuthUserMapper && user?._id) {
      try {
        const result = await this.options.betterAuthUserMapper.cleanupIamDataForDeletedUser(user._id);
        if (result.accountsDeleted > 0 || result.sessionsDeleted > 0) {
          this.userServiceLogger.debug(
            `Cleaned up IAM data for deleted user ${id}: accounts=${result.accountsDeleted}, sessions=${result.sessionsDeleted}`,
          );
        }
      } catch (error) {
        this.userServiceLogger.error(
          `Failed to cleanup IAM data for deleted user: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        // Don't throw - cleanup failure shouldn't block the delete response
      }
    }

    return deletedUser;
  }
}
