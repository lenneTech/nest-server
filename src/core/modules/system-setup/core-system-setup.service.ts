import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { CoreBetterAuthUserMapper } from '../better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthService } from '../better-auth/core-better-auth.service';
import { ErrorCode } from '../error-code/error-codes';

/**
 * Input for creating the initial admin user
 */
export interface SystemSetupInitInput {
  email: string;
  name?: string;
  password: string;
}

/**
 * Response for successful init
 */
export interface SystemSetupInitResult {
  email: string;
  message: string;
  success: boolean;
}

/**
 * Response for setup status check
 */
export interface SystemSetupStatus {
  betterAuthEnabled: boolean;
  needsSetup: boolean;
}

/**
 * CoreSystemSetupService provides initial admin creation for fresh deployments.
 *
 * This service allows creating the first admin user when the system has zero users.
 * It bypasses BetterAuth's disableSignUp check by using the internal adapter directly,
 * which is the same approach used by Better-Auth's own admin plugin.
 *
 * Security:
 * - Only works when zero users exist in the database
 * - Once any user exists, the init endpoint is permanently locked
 * - Race conditions handled by MongoDB unique email index
 */
@Injectable()
export class CoreSystemSetupService {
  private readonly logger = new Logger(CoreSystemSetupService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly betterAuthService: CoreBetterAuthService,
    private readonly userMapper: CoreBetterAuthUserMapper,
  ) {}

  /**
   * Check if the system needs initial setup (zero users)
   */
  async getSetupStatus(): Promise<SystemSetupStatus> {
    const userCount = await this.connection.collection('users').countDocuments({});
    return {
      betterAuthEnabled: this.betterAuthService.isEnabled(),
      needsSetup: userCount === 0,
    };
  }

  /**
   * Create the initial admin user when zero users exist.
   *
   * Uses BetterAuth's internalAdapter to bypass disableSignUp,
   * then syncs to nest-server users collection with admin role.
   */
  async createInitialAdmin(input: SystemSetupInitInput): Promise<SystemSetupInitResult> {
    // Pre-check: only allow when zero users exist
    const userCount = await this.connection.collection('users').countDocuments({});
    if (userCount > 0) {
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE);
    }

    // Ensure BetterAuth is enabled
    if (!this.betterAuthService.isEnabled()) {
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_BETTERAUTH_REQUIRED);
    }

    const authInstance = this.betterAuthService.getInstance();
    if (!authInstance) {
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_BETTERAUTH_REQUIRED);
    }

    try {
      // Access BetterAuth internal context (same pattern as core-better-auth-api.middleware.ts)
      const context = await authInstance.$context;

      // Normalize password for IAM (SHA256 if plain text)
      const normalizedPassword = this.userMapper.normalizePasswordForIam(input.password);

      // Create user via internalAdapter (bypasses disableSignUp)
      const iamUser = await context.internalAdapter.createUser({
        email: input.email,
        emailVerified: true,
        name: input.name || input.email.split('@')[0],
      });

      if (!iamUser) {
        throw new Error('Failed to create IAM user');
      }

      // Hash password and create credential account
      const hashedPassword = await context.password.hash(normalizedPassword);
      await context.internalAdapter.linkAccount({
        accountId: iamUser.id,
        password: hashedPassword,
        providerId: 'credential',
        userId: iamUser.id,
      });

      // Sync to nest-server users collection
      const syncedUser = await this.userMapper.linkOrCreateUser({
        email: iamUser.email,
        emailVerified: true,
        id: iamUser.id,
        name: iamUser.name,
      });

      if (!syncedUser) {
        throw new Error('Failed to sync user to nest-server collection');
      }

      // Set admin role directly
      await this.connection
        .collection('users')
        .updateOne({ _id: syncedUser._id }, { $set: { roles: ['admin'], updatedAt: new Date() } });

      // Sync password to Legacy Auth for backwards compatibility
      await this.userMapper.syncPasswordToLegacy(iamUser.id, input.email, input.password);

      this.logger.log(`Initial admin user created: ${input.email}`);

      return {
        email: input.email,
        message: 'Initial admin user created successfully',
        success: true,
      };
    } catch (error) {
      // Handle duplicate email (race condition via MongoDB unique index)
      if (error instanceof Error && (error.message?.includes('duplicate key') || error.message?.includes('E11000'))) {
        throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE);
      }

      // Re-throw known exceptions
      if (error instanceof ForbiddenException) {
        throw error;
      }

      this.logger.error(`System setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE);
    }
  }
}
