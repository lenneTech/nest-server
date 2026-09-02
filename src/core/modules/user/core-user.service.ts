import { BadRequestException, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import bcrypt = require('bcrypt');
import crypto = require('crypto');
import { sha256 } from 'js-sha256';
import { Document, Model } from 'mongoose';

import { looksLikeSystemRole, SYSTEM_ROLE_PREFIX } from '../../common/enums/role.enum';
import { maskEmail } from '../../common/helpers/logging.helper';
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
        // Application-level email-uniqueness check. The unique index alone is NOT
        // sufficient: on a FRESH database Mongoose builds indexes asynchronously
        // (autoIndex), so an early duplicate sign-up can slip through before the
        // index exists — observed as a load-dependent e2e flake, and the same
        // window exists on a freshly deployed production database. The index
        // remains the backstop for truly concurrent duplicate requests.
        if (data.input?.email) {
          const existing = await this.mainDbModel.findOne({ email: data.input.email }).lean().exec();
          if (existing) {
            throw new BadRequestException('Email address already in use');
          }
        }

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
          if (error?.errors?.email?.kind === 'unique' || error?.code === 11000) {
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
      // The token is NOT echoed. It is attacker-supplied so nothing secret leaks, but it lands
      // in the response body and in every log line that records the exception — and this logger
      // feeds the ADMIN-readable Hub log buffer. An unbounded caller-controlled string there is
      // free log-stuffing, and the message is no more useful for it.
      throw new NotFoundException('Invalid or expired password reset token');
    }

    // Capture the submitted password for the IAM sync before the closure below
    // reassigns `newPassword` to its sha256 form.
    //
    // It is passed on exactly as received, INCLUDING an already-sha256-hashed
    // one. This used to skip the sync for a 64-hex value, on the reasoning that
    // "IAM uses scrypt, not bcrypt+sha256" — but the sync does not need a plain
    // password: `hashPasswordForBetterAuth` runs its input through
    // `normalizePasswordForIam`, which passes a 64-hex string through unchanged
    // by design, and `migrateAccountToIam` is fed the very same pre-hashed value
    // when an account is created.
    //
    // The guard therefore disabled the sync for exactly the clients this stack
    // ships. The lt frontends hash in the browser before sending — seven call
    // sites in `nuxt-extensions/src/runtime/lib/auth-client.ts` (`signIn.email`,
    // `resetPassword`, `changePassword` and the rest) run `ltSha256` on the
    // password first. That is independent of the `sha256` config option, which
    // only governs what the SERVER does with a plaintext password it happens to
    // receive. So the value arriving here is 64-hex whatever that option says,
    // and every such reset took the skipped branch.
    //
    // The legacy password was updated, the IAM credential was not, and sign-in —
    // which goes through IAM — kept accepting the OLD password and refusing the
    // new one. The endpoint reported success throughout, so the failure surfaced
    // only at the next sign-in.
    //
    // A client that posts a plaintext password was never affected: the old guard
    // let that one through, and the sync normalized it the same way IAM does.
    const passwordForIamSync = newPassword;

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
          // A reset is what somebody reaches for after a suspected takeover, so it must not
          // leave the attacker's session live. Clearing the refresh tokens ends every legacy
          // session; the IAM half is `betterAuth.emailAndPassword.revokeSessionsOnPasswordReset`,
          // which is off by default because it is a behaviour change for existing deployments —
          // the migration guide recommends turning it on.
          //
          // Without this, "the reset now lands in both stores" would still leave the account
          // reachable with the credential the reset was meant to retire.
          refreshTokens: {},
        }).save();

        // Sync password to Better-Auth (IAM) if mapper is available
        // This ensures users can sign in via IAM after password reset
        if (this.options?.betterAuthUserMapper && passwordForIamSync && dbObject.email) {
          try {
            // Same reasoning as in update(): a `false` return means the reset landed in the
            // legacy store only, which is the shape of failure this whole path exists to
            // prevent. It must not be indistinguishable from success.
            const synced = await this.options.betterAuthUserMapper.syncPasswordChangeToIam(
              dbObject.email,
              passwordForIamSync,
            );
            if (!synced) {
              this.userServiceLogger.warn(
                `Password reset for ${maskEmail(dbObject.email)} was NOT synced to IAM (no credential account) — ` +
                  'the legacy password now differs from the IAM credential.',
              );
            }
          } catch (error) {
            // Log but don't fail - Legacy Auth password was updated successfully
            this.userServiceLogger.warn(
              `Failed to sync password reset to IAM for ${maskEmail(dbObject.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }

        return updatedUser;
      },
      { dbObject, serviceOptions },
    );
  }

  /**
   * Set a password-reset token for an email address
   *
   * Returns `null` for an unknown address when `auth.passwordReset.preventUserEnumeration` is on
   * (the default since 11.38.0) — the caller must then answer exactly as it would for a known one.
   * With the option off it throws `NotFoundException`, the pre-11.38.0 behaviour.
   *
   * WHY THE DEFAULT CHANGED
   *
   * Throwing made the endpoint an account oracle: HTTP 404 for an unknown address, 201 for a known
   * one, so anyone could test who has an account. In a multi-tenant product that also answers who
   * works at which customer. The framework already answers this correctly on the IAM path —
   * Better-Auth's `/request-password-reset` returns the same body either way — so the two halves
   * of one framework disagreed about the same question.
   *
   * THE STATUS CODE IS THE SMALLER HALF
   *
   * Response TIME distinguishes the cases too, and by far more: the known path writes a token and
   * (in the caller) sends mail, the unknown path returns immediately. This method equalises what it
   * can — the token generation still happens, so the CPU cost matches — but the mail send lives in
   * the caller. A `sendPasswordResetMail()` that AWAITS the send leaks the difference as latency,
   * whatever this method does. `src/server/modules/user/user.service.ts` shows the shape that does
   * not; the IAM path uses the same trick, with the reasoning recorded in `better-auth.config.ts`.
   *
   * Anything measuring this honestly should say so rather than claim the channel is closed.
   */
  async setPasswordResetTokenForEmail(email: string, serviceOptions?: ServiceOptions): Promise<null | TUser> {
    // Get user
    const dbObject = await this.mainDbModel.findOne({ email }).exec();
    if (!dbObject) {
      const preventEnumeration =
        this.configService.getFastButReadOnly('auth')?.passwordReset?.preventUserEnumeration !== false;

      if (!preventEnumeration) {
        throw new NotFoundException(`No user found with email: ${email}`);
      }

      // Do the work the known path does, so the two do not differ in CPU cost. It is cheap next to
      // a mail send, which is why this alone does not close the timing channel — see the note above.
      crypto.randomBytes(32).toString('hex');

      this.userServiceLogger.debug(`Password reset requested for an unknown address (${maskEmail(email)})`);
      return null;
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

    // Reject system roles (s_*). This is the framework's canonical "assign roles" API and it writes
    // straight through findByIdAndUpdate, so neither MapAndValidatePipe nor check() sees the values.
    // mongooseSystemRolePlugin is the backstop below this; the explicit check here exists to fail
    // before the DB round-trip and with a message naming the offending values.
    const systemRoles = roles.filter((role) => looksLikeSystemRole(role));
    if (systemRoles.length) {
      throw new BadRequestException(
        `System roles (${SYSTEM_ROLE_PREFIX}*) must never be stored in user.roles: ${systemRoles.join(', ')}`,
      );
    }

    // Update and return user
    return this.process(
      async () => {
        const user = await this.mainDbModel.findByIdAndUpdate(userId, { roles }).exec();

        // Invalidate BetterAuth user cache so changed roles take effect immediately
        if (this.options?.betterAuthUserMapper && (user as any)?.iamId) {
          this.options.betterAuthUserMapper.invalidateUserCache((user as any).iamId);
        }

        return user;
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

    // Capture the submitted password for the IAM sync before super.update()
    // hashes it in place.
    //
    // Passed on exactly as received, including an already-sha256-hashed one —
    // see the note in `resetPassword`: the sync normalizes a 64-hex value
    // through unchanged, so skipping it there disabled the sync for the
    // standard setup, where the frontend hashes before sending.
    const passwordForIamSync = (input as any).password;

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
    if (this.options?.betterAuthUserMapper && passwordForIamSync && oldUser?.email) {
      try {
        // Report what actually happened, not that the call was made. `syncPasswordChangeToIam`
        // answers `false` — never throws — when there is no IAM credential to update, and
        // logging success regardless is how a half-applied password change stays invisible:
        // the endpoint reports success, the user is left with two different passwords, and
        // nothing in the log says so.
        const synced = await this.options.betterAuthUserMapper.syncPasswordChangeToIam(
          oldUser.email,
          passwordForIamSync,
        );
        if (synced) {
          this.userServiceLogger.debug(`Synced password change to IAM for user ${maskEmail(oldUser.email)}`);
        } else {
          this.userServiceLogger.warn(
            `Password change for ${maskEmail(oldUser.email)} was NOT synced to IAM (no credential account) — ` +
              'the legacy password now differs from the IAM credential.',
          );
        }
      } catch (error) {
        this.userServiceLogger.warn(
          `Failed to sync password change to IAM for ${maskEmail(oldUser.email)}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        // Don't throw - password sync failure shouldn't block the update
      }
    }

    // Invalidate BetterAuth user cache when roles or verified status may have changed
    if (this.options?.betterAuthUserMapper && (oldUser as any)?.iamId) {
      const rolesChanged = 'roles' in (input as any);
      const verifiedChanged = 'verified' in (input as any) || 'emailVerified' in (input as any);
      if (rolesChanged || verifiedChanged) {
        this.options.betterAuthUserMapper.invalidateUserCache((oldUser as any).iamId);
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
