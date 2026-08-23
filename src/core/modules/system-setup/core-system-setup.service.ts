import { ForbiddenException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { isEmail } from 'class-validator';
import { Connection } from 'mongoose';

import { ConfigService } from '../../common/services/config.service';
import { CoreBetterAuthUserMapper } from '../better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthService } from '../better-auth/core-better-auth.service';
import { ErrorCode } from '../error-code/error-codes';

/**
 * Collection holding the bootstrap claim markers.
 *
 * Native collection access is intentional here: no Mongoose schema exists for it
 * (see docs/native-driver-security.md).
 */
const SETUP_LOCK_COLLECTION = 'system-setup-locks';

/**
 * How long an initial-admin claim may stand before another replica takes it over.
 *
 * Long enough that a slow but live creation is never stolen, short enough that a crashed
 * claimer does not lock the deployment out for good.
 */
const INITIAL_ADMIN_CLAIM_STALE_AFTER_MS = 5 * 60_000;

/** `_id` of the marker claiming the initial-admin creation */
const INITIAL_ADMIN_LOCK_ID = 'initial-admin';

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
export class CoreSystemSetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CoreSystemSetupService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly betterAuthService: CoreBetterAuthService,
    private readonly userMapper: CoreBetterAuthUserMapper,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Automatically create the initial admin on server start if configured via
   * `systemSetup.initialAdmin` in config or ENV variables.
   *
   * Uses OnApplicationBootstrap (not OnModuleInit) to ensure BetterAuth
   * is fully initialized before attempting user creation.
   */
  async onApplicationBootstrap(): Promise<void> {
    const initialAdmin = this.configService.configFastButReadOnly?.systemSetup?.initialAdmin;

    // No initialAdmin config at all → skip silently
    if (!initialAdmin) {
      return;
    }

    // Partial credentials → warn and skip
    if (!initialAdmin.email || !initialAdmin.password) {
      const missing = [!initialAdmin.email && 'email', !initialAdmin.password && 'password'].filter(Boolean).join(', ');
      this.logger.warn(`Incomplete initialAdmin config - missing: ${missing}. Auto-creation skipped.`);
      return;
    }

    // Validate email format (same validator as @IsEmail() decorator)
    if (!isEmail(initialAdmin.email)) {
      this.logger.warn(`Invalid initialAdmin email format: "${initialAdmin.email}". Auto-creation skipped.`);
      return;
    }

    // Validate password is not empty/whitespace
    if (!initialAdmin.password.trim()) {
      this.logger.warn('Empty initialAdmin password. Auto-creation skipped.');
      return;
    }

    const status = await this.getSetupStatus();
    if (!status.needsSetup) {
      return;
    }

    if (!status.betterAuthEnabled) {
      this.logger.warn('Initial admin auto-creation skipped: BetterAuth not enabled');
      return;
    }

    // The atomic claim lives in createInitialAdmin() so that BOTH entry points — this
    // one and the anonymous POST /system-setup/init — serialize on the same marker.
    // Claiming here as well would take the claim twice on this path and leave the
    // public path unguarded.
    try {
      const result = await this.createInitialAdmin({
        email: initialAdmin.email,
        name: initialAdmin.name,
        password: initialAdmin.password,
      });
      this.logger.log(`Auto-created initial admin on startup: ${result.email}`);
    } catch (error) {
      // The claim is released by createInitialAdmin() itself, which is the only place
      // that takes it — so a replica that crashed mid-creation cannot block setup on
      // every future boot, and the marker has exactly one owner.
      if (error instanceof ForbiddenException) {
        this.logger.log('Initial admin auto-creation skipped (users already exist or claimed elsewhere)');
      } else {
        this.logger.warn(
          `Initial admin auto-creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * Try to claim the initial-admin creation for this instance
   *
   * The upsert on a fixed `_id` is atomic, so exactly one of N concurrently booting
   * replicas sees no previous document and wins the claim.
   *
   * @returns true when this instance may create the initial admin
   */
  protected async claimInitialAdminSetup(): Promise<boolean> {
    try {
      const collection = this.connection.collection(SETUP_LOCK_COLLECTION);

      // The marker is a CLAIM, not a permanent record: a replica SIGKILLed between claiming and
      // creating (OOM, node drain, a failed first rollout — all ordinary) never reaches the
      // release in the catch below. Without an expiry that leaves a deployment with zero users
      // and no way in, recoverable only by deleting a document from an undocumented collection.
      // A stale claim is therefore taken over rather than obeyed.
      const staleBefore = new Date(Date.now() - INITIAL_ADMIN_CLAIM_STALE_AFTER_MS);
      await collection.deleteOne({ _id: INITIAL_ADMIN_LOCK_ID as any, claimedAt: { $lt: staleBefore } });

      const previous = await collection.findOneAndUpdate(
        { _id: INITIAL_ADMIN_LOCK_ID as any },
        { $setOnInsert: { claimedAt: new Date() } },
        { returnDocument: 'before', upsert: true },
      );

      // No previous document → this instance inserted the marker and owns the setup
      return !previous;
    } catch (error) {
      // Two replicas upserting the same `_id` at the very same moment: one insert wins,
      // the other gets a duplicate key error — which means the claim is taken.
      if (error instanceof Error && (error.message?.includes('duplicate key') || error.message?.includes('E11000'))) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Remove the initial-admin claim marker so a later boot can retry the setup
   */
  protected async releaseInitialAdminSetupClaim(): Promise<void> {
    try {
      await this.connection.collection(SETUP_LOCK_COLLECTION).deleteOne({ _id: INITIAL_ADMIN_LOCK_ID as any });
    } catch (error) {
      // Never mask the failure that triggered the release
      this.logger.warn(
        `Failed to release initial admin setup claim: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

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

    // The count check above is check-then-act, and this method is reachable ANONYMOUSLY
    // via POST /system-setup/init. Two concurrent callers with DIFFERENT emails both pass
    // it and both get an admin — the E11000 handler below only catches the same-email
    // case. The claim is the same marker the boot path uses, so the HTTP path and the
    // auto-bootstrap also serialize against each other instead of racing: an attacker
    // racing a fresh deployment can no longer obtain an admin account ALONGSIDE the
    // configured one.
    if (!(await this.claimInitialAdminSetup())) {
      // Say WHICH guard refused. This one and the user-count guard above share
      // ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE, and the response cannot tell them apart — so
      // without this line a caller that just emptied `users` is told users exist while the
      // collection is empty. That is a genuinely expensive thing to diagnose from the outside:
      // the marker outlives a SUCCESSFUL setup (it is released only on failure), so the usual
      // "reset the database" reflex does not clear it.
      // `log`, not `warn`. Both entry points reach this line, and for one of them a refusal is
      // the EXPECTED outcome: on a multi-replica fresh rollout every replica but one loses the
      // claim race, so `warn` would fire N-1 times per normal deployment — each time immediately
      // followed by onApplicationBootstrap's own INFO line calling the same event a normal skip.
      // Two records with contradictory severity for one non-event trains operators to ignore the
      // louder one. The HTTP caller is not left without a diagnosis: the message is unchanged and
      // an operator investigating a 403 reads it at the default level.
      this.logger.log(
        `System setup refused: the initial-admin claim in "${SETUP_LOCK_COLLECTION}" is held. ` +
          'Either another instance is running the setup right now, or a previous SUCCESSFUL setup ' +
          'left the marker behind — it is removed only when creation FAILS. If you reset the ' +
          `database to replay the setup, drop "${SETUP_LOCK_COLLECTION}" alongside "users"; ` +
          `otherwise setup stays refused until the claim goes stale after ` +
          `${INITIAL_ADMIN_CLAIM_STALE_AFTER_MS / 60_000} minutes.`,
      );
      throw new ForbiddenException(ErrorCode.SYSTEM_SETUP_NOT_AVAILABLE);
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
      // Release the claim we took above: a caller that failed mid-creation must not
      // leave a deployment with zero users and no way in. The marker is additionally
      // stale-expiring, so this is belt AND braces for the crash-before-release case.
      await this.releaseInitialAdminSetupClaim();

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
