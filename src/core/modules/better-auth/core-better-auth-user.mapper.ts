import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { randomBytes, scrypt, ScryptOptions } from 'crypto';
import { sha256 } from 'js-sha256';
import { ObjectId } from 'mongodb';
import { Connection } from 'mongoose';

// Promisify Node.js crypto.scrypt
const scryptPromise = (password: string, salt: string, keylen: number, options: ScryptOptions): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
};

import { RoleEnum } from '../../common/enums/role.enum';
import { maskEmail } from '../../common/helpers/logging.helper';

/**
 * Interface for Better-Auth session user
 */
export interface BetterAuthSessionUser {
  createdAt?: Date;
  email: string;
  emailVerified?: boolean;
  id: string;
  image?: string;
  name?: string;
  updatedAt?: Date;
}

/**
 * Interface for mapped user with role capabilities
 */
export interface MappedUser {
  /**
   * Marker to identify Better-Auth authenticated users
   * Used by AuthGuard to skip Passport authentication for these users
   */
  _authenticatedViaBetterAuth: true;
  email: string;
  emailVerified?: boolean;
  hasRole: (roles: string | string[]) => boolean;
  iamId: string;
  id: string;
  image?: string;
  name?: string;
  roles: string[];
  /**
   * Whether the user is verified (from our database)
   * Used for S_VERIFIED role check
   */
  verified?: boolean;
}

/**
 * Interface for migration status result
 */
export interface MigrationStatus {
  canDisableLegacyAuth: boolean;
  fullyMigratedUsers: number;
  migrationPercentage: number;
  pendingMigrationUsers: number;
  pendingUserEmails: string[];
  totalUsers: number;
  usersWithIamAccount: number;
  usersWithIamId: number;
}

/**
 * Interface for synced user document returned from database
 */
export interface SyncedUserDocument {
  _id: any;
  avatar?: string;
  createdAt: Date;
  email: string;
  firstName?: string;
  iamId: string;
  lastName?: string;
  password?: string;
  roles: string[];
  updatedAt: Date;
  verified?: boolean;
}

/**
 * Service to map Better-Auth users to the application's User model
 *
 * This service bridges the gap between Better-Auth's session-based users
 * and the application's role-based security system.
 *
 * It also provides bidirectional password synchronization:
 * - IAM → Legacy: Copies password from `accounts` to `users.password`
 * - Legacy → IAM: Creates account entry in `accounts` from `users.password`
 */
@Injectable()
export class CoreBetterAuthUserMapper {
  private readonly logger = new Logger(CoreBetterAuthUserMapper.name);

  constructor(@Optional() @InjectConnection() private readonly connection?: Connection) {}

  /**
   * Maps a Better-Auth session user to a user with role capabilities
   *
   * This method:
   * 1. Looks up the user in the application's user collection by email
   * 2. If found, returns the full user with roles and hasRole() method
   * 3. If not found, returns a minimal user with default roles
   *
   * @param sessionUser - The Better-Auth session user
   * @returns A mapped user with role capabilities
   */
  async mapSessionUser(sessionUser: BetterAuthSessionUser): Promise<MappedUser | null> {
    if (!sessionUser?.id || !sessionUser?.email) {
      return null;
    }

    // If no database connection, return user with default roles
    if (!this.connection) {
      this.logger.warn('No database connection available - using default role mapping');
      return this.createMappedUser({
        email: sessionUser.email,
        emailVerified: sessionUser.emailVerified,
        iamId: sessionUser.id,
        id: sessionUser.id,
        image: sessionUser.image,
        name: sessionUser.name,
        roles: [],
        verified: sessionUser.emailVerified, // Use Better-Auth emailVerified status
      });
    }

    try {
      // Look up the user in our database by email OR iamId
      // This ensures we find the user regardless of which system they signed up with
      const userCollection = this.connection.collection('users');
      const dbUser = await userCollection.findOne({
        $or: [{ email: sessionUser.email }, { iamId: sessionUser.id }],
      });

      if (dbUser) {
        // User exists in our database - use their roles and verified status
        const roles = Array.isArray(dbUser.roles) ? dbUser.roles : [];
        // Use database verified status, fallback to Better-Auth emailVerified
        const verified = dbUser.verified === true || sessionUser.emailVerified === true;

        return this.createMappedUser({
          email: sessionUser.email,
          emailVerified: sessionUser.emailVerified,
          iamId: sessionUser.id,
          id: dbUser._id.toString(),
          image: sessionUser.image,
          name: sessionUser.name,
          roles,
          verified,
        });
      }

      // User doesn't exist in our database yet
      // This can happen if they signed up through Better-Auth but not legacy auth
      // Return a user with default roles (S_USER since they're authenticated)
      this.logger.debug(`Better-Auth user ${maskEmail(sessionUser.email)} not found in users collection`);

      return this.createMappedUser({
        email: sessionUser.email,
        emailVerified: sessionUser.emailVerified,
        iamId: sessionUser.id,
        id: sessionUser.id, // Use Better-Auth ID as fallback
        image: sessionUser.image,
        name: sessionUser.name,
        roles: [], // No default roles - S_ roles are system checks, not actual roles
        verified: sessionUser.emailVerified, // Use Better-Auth emailVerified status
      });
    } catch (error) {
      this.logger.error(`Error mapping Better-Auth user: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Creates a mapped user object with the hasRole method
   */
  private createMappedUser(userData: Omit<MappedUser, '_authenticatedViaBetterAuth' | 'hasRole'>): MappedUser {
    const roles = userData.roles || [];

    return {
      ...userData,
      _authenticatedViaBetterAuth: true,
      hasRole: (checkRoles: string | string[]): boolean => {
        const rolesToCheck = Array.isArray(checkRoles) ? checkRoles : [checkRoles];

        // Check for special roles
        if (rolesToCheck.includes(RoleEnum.S_EVERYONE)) {
          return true;
        }

        if (rolesToCheck.includes(RoleEnum.S_USER)) {
          return true; // User is authenticated via Better-Auth
        }

        if (rolesToCheck.includes(RoleEnum.S_NO_ONE)) {
          return false;
        }

        // S_VERIFIED check - uses verified field (from DB or Better-Auth emailVerified)
        if (rolesToCheck.includes(RoleEnum.S_VERIFIED)) {
          return userData.verified === true;
        }

        // Check actual roles
        return rolesToCheck.some((role) => roles.includes(role));
      },
      roles,
    };
  }

  // ===================================================================================================================
  // Password Sync
  // ===================================================================================================================

  /**
   * Syncs password to users.password with bcrypt hash
   *
   * This enables: IAM Sign-Up → Legacy Sign-In
   * After a user signs up through Better-Auth, we hash the plain password
   * with bcrypt and store it in users.password so they can sign in via Legacy Auth.
   *
   * NOTE: We cannot copy the Better-Auth scrypt hash because Legacy Auth uses bcrypt.
   * We need the plain password to create a bcrypt-compatible hash.
   *
   * @param iamUserId - The Better-Auth user ID (from sessions/accounts)
   * @param userEmail - The user's email address
   * @param plainPassword - The plain password to hash with bcrypt
   * @returns true if sync was successful, false otherwise
   */
  async syncPasswordToLegacy(iamUserId: string, userEmail: string, plainPassword?: string): Promise<boolean> {
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot sync password to legacy');
      return false;
    }

    if (!plainPassword) {
      return false;
    }

    try {
      const usersCollection = this.connection.collection('users');

      // Hash password with bcrypt for Legacy Auth compatibility
      // Legacy Auth uses: bcrypt.compare(password, hash) or bcrypt.compare(sha256(password), hash)
      // We ALWAYS store bcrypt(sha256(password)) to ensure both formats work:
      // - Client sends plain password → sha256 → bcrypt → stored
      // - Client sends SHA256 hash → already SHA256 → bcrypt → stored
      // This ensures Legacy login works regardless of what format the client sends
      const normalizedPassword = this.normalizePasswordForIam(plainPassword);
      const saltRounds = 10;
      const bcryptHash = await bcrypt.hash(normalizedPassword, saltRounds);

      // Update the users collection with the bcrypt hash
      const result = await usersCollection.updateOne(
        { $or: [{ email: userEmail }, { iamId: iamUserId }] },
        { $set: { password: bcryptHash, updatedAt: new Date() } },
      );

      return result.modifiedCount > 0;
    } catch (error) {
      this.logger.error(
        `Error syncing password to legacy: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  /**
   * Syncs a password change from Legacy Auth to Better-Auth (IAM)
   *
   * This enables: Legacy Password Reset/Change → IAM Sign-In
   * When a user resets or changes their password via Legacy Auth, this method
   * updates the password hash in the Better-Auth `account` collection.
   *
   * Use cases:
   * - Password reset via Legacy Auth (`CoreUserService.resetPassword`)
   * - Password change via Legacy Auth (user update with password field)
   * - Bulk password updates
   *
   * @param userEmail - The user's email address
   * @param plainPassword - The new plain password to hash with scrypt for IAM
   * @returns true if sync was successful, false otherwise
   */
  async syncPasswordChangeToIam(userEmail: string, plainPassword: string): Promise<boolean> {
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot sync password to IAM');
      return false;
    }

    if (!plainPassword) {
      return false;
    }

    try {
      const usersCollection = this.connection.collection('users');
      const accountCollection = this.connection.collection('account');

      // Find the user
      const user = await usersCollection.findOne({ email: userEmail });
      if (!user) {
        return false;
      }

      // Check if user has an IAM credential account
      const existingAccount = await accountCollection.findOne({
        providerId: 'credential',
        userId: user._id,
      });

      if (!existingAccount) {
        return false;
      }

      // Hash password with scrypt for Better-Auth
      const scryptHash = await this.hashPasswordForBetterAuth(plainPassword);

      // Update the account password
      await accountCollection.updateOne(
        { _id: existingAccount._id },
        {
          $set: {
            password: scryptHash,
            updatedAt: new Date(),
          },
        },
      );

      return true;
    } catch (error) {
      this.logger.error(`Error syncing password to IAM: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  /**
   * Creates a Better-Auth account entry from legacy user's password
   *
   * This enables: Legacy Sign-Up → IAM Sign-In
   * When a legacy user wants to use Better-Auth, this creates the necessary
   * account entry. Since Legacy Auth uses sha256+bcrypt and Better-Auth uses
   * only bcrypt, we need the plain password to create a compatible hash.
   *
   * @param userEmail - The user's email address
   * @param plainPassword - Optional plain password to create Better-Auth compatible hash
   * @returns true if account was created, false otherwise
   */
  async migrateAccountToIam(userEmail: string, plainPassword?: string): Promise<boolean> {
    if (!this.connection) {
      return false;
    }

    try {
      const usersCollection = this.connection.collection('users');
      const accountsCollection = this.connection.collection('account');

      // Find the legacy user with password
      const legacyUser = await usersCollection.findOne({ email: userEmail });

      if (!legacyUser?.password) {
        return false;
      }

      // IMPORTANT: Verify the provided password matches the legacy hash
      // This prevents migration with a wrong password
      // Legacy Auth uses two formats for backwards compatibility:
      // 1. bcrypt(password) - direct hash
      // 2. bcrypt(sha256(password)) - sha256 then bcrypt
      if (plainPassword) {
        const directMatch = await bcrypt.compare(plainPassword, legacyUser.password);
        const sha256Match = await bcrypt.compare(sha256(plainPassword), legacyUser.password);
        if (!directMatch && !sha256Match) {
          // Security: Wrong password provided for migration - reject
          this.logger.warn(`Migration password verification failed for ${maskEmail(userEmail)}`);
          return false;
        }
      } else {
        // No password provided - cannot verify, cannot migrate
        return false;
      }

      // Better-Auth stores account.userId as ObjectId that references users._id
      // The id field is a secondary string identifier used in API responses
      const userMongoId = legacyUser._id as ObjectId;
      const userIdHex = userMongoId.toHexString();

      // Update user with Better-Auth fields if not already present
      if (!legacyUser.iamId) {
        const now = new Date();
        // Generate a nanoid-style string id for the 'id' field (for API responses)
        const stringId = this.generateId();

        await usersCollection.updateOne(
          { _id: legacyUser._id },
          {
            $set: {
              emailVerified: legacyUser.verified === true,
              iamId: stringId,
              id: stringId,
              name: [legacyUser.firstName, legacyUser.lastName].filter(Boolean).join(' ') || undefined,
              updatedAt: now,
            },
          },
        );
      }

      // Check if credential account already exists
      // Better-Auth stores userId as ObjectId referencing users._id
      const existingAccount = await accountsCollection.findOne({
        providerId: 'credential',
        userId: userMongoId,
      });

      if (existingAccount) {
        return true;
      }

      // Create the credential account with Better-Auth compatible scrypt hash
      const passwordHash = await this.hashPasswordForBetterAuth(plainPassword);

      const now = new Date();
      // Store account matching Better-Auth's format:
      // - userId: ObjectId referencing users._id
      // - accountId: string version of users._id
      await accountsCollection.insertOne({
        accountId: userIdHex,
        createdAt: now,
        id: this.generateId(),
        password: passwordHash,
        providerId: 'credential',
        updatedAt: now,
        userId: userMongoId,
      });

      return true;
    } catch (error) {
      this.logger.error(`Error migrating account to IAM: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  /**
   * Generates a unique ID for Better-Auth entities
   * Uses the same format as Better-Auth (nanoid-style) with cryptographically secure randomness
   */
  private generateId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(21);
    let result = '';
    for (let i = 0; i < 21; i++) {
      result += chars.charAt(bytes[i] % chars.length);
    }
    return result;
  }

  /**
   * Normalizes a password for IAM operations
   *
   * This ensures consistency with Legacy Auth's SHA256 handling.
   * Legacy Auth accepts both plain passwords and SHA256 hashes.
   * IAM always uses SHA256(password) internally for consistency.
   *
   * - If password is already SHA256 (64 hex chars) → use as-is
   * - If password is plain text → convert to SHA256
   *
   * This allows clients to send either format and get consistent behavior.
   *
   * @param password - Plain password or SHA256 hash
   * @returns Normalized password (always SHA256 format)
   */
  normalizePasswordForIam(password: string): string {
    // Check if already SHA256 hash (64 hex characters)
    if (/^[a-f0-9]{64}$/i.test(password)) {
      return password;
    }
    // Convert plain password to SHA256
    return sha256(password);
  }

  /**
   * Hashes a password using Better-Auth's scrypt format
   *
   * Better-Auth uses scrypt with:
   * - N: 16384, r: 16, p: 1, dkLen: 64
   * - 16-byte salt (32 hex chars)
   * - Format: "salt:hash" (both hex encoded)
   *
   * NOTE: This method normalizes the password to SHA256 format first
   * to ensure consistency with Legacy Auth.
   *
   * @param password - Plain password or SHA256 hash to hash
   * @returns Password hash in Better-Auth format (salt:hash)
   */
  private async hashPasswordForBetterAuth(password: string): Promise<string> {
    // Normalize password to SHA256 format for consistency with Legacy Auth
    const normalizedPassword = this.normalizePasswordForIam(password);

    // Generate 16-byte random salt (same as Better-Auth)
    const saltBytes = randomBytes(16);
    const salt = saltBytes.toString('hex');

    // Scrypt parameters matching Better-Auth:
    // N (cost): 16384, r (blockSize): 16, p (parallelization): 1
    // maxmem: 128 * N * r * 2 = 67108864 bytes
    const keyLength = 64;
    const scryptOptions = {
      maxmem: 128 * 16384 * 16 * 2,
      N: 16384,
      p: 1,
      r: 16,
    };

    // Hash normalized password with scrypt using Node.js crypto
    const key = await scryptPromise(normalizedPassword.normalize('NFKC'), salt, keyLength, scryptOptions);

    // Return in Better-Auth format: salt:hash
    return `${salt}:${key.toString('hex')}`;
  }

  /**
   * Links an existing user or creates a new user from Better-Auth session data
   *
   * This method:
   * 1. Searches by email OR iamId (supports both login paths)
   * 2. Creates new user if not found (with default S_USER role)
   * 3. Links existing user by setting iamId
   *
   * NOTE: No password handling is needed because both Legacy Auth and Better-Auth
   * use bcrypt-compatible password hashing. Users can authenticate with either system.
   *
   * @param sessionUser - The Better-Auth session user
   * @param additionalData - Additional data to set on the user
   * @returns The linked/created user document or null on error
   */
  async linkOrCreateUser(
    sessionUser: BetterAuthSessionUser,
    additionalData?: Record<string, any>,
  ): Promise<null | SyncedUserDocument> {
    if (!sessionUser?.email) {
      return null;
    }

    // Cannot sync without database connection
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot sync user');
      return null;
    }

    try {
      const userCollection = this.connection.collection('users');

      // Check if user already exists
      const existingUser = await userCollection.findOne({
        $or: [{ email: sessionUser.email }, { iamId: sessionUser.id }],
      });

      // Process additionalData to convert termsAndPrivacyAccepted to timestamp
      const processedAdditionalData = { ...additionalData };
      if (processedAdditionalData?.termsAndPrivacyAccepted === true) {
        processedAdditionalData.termsAndPrivacyAcceptedAt = new Date();
        delete processedAdditionalData.termsAndPrivacyAccepted;
      } else {
        delete processedAdditionalData?.termsAndPrivacyAccepted;
      }

      const updateData: Record<string, any> = {
        email: sessionUser.email,
        ...(sessionUser.name && { firstName: sessionUser.name.split(' ')[0] }),
        ...(sessionUser.name &&
          sessionUser.name.includes(' ') && {
            lastName: sessionUser.name.split(' ').slice(1).join(' '),
          }),
        ...(sessionUser.emailVerified !== undefined && { verified: sessionUser.emailVerified }),
        ...(sessionUser.image && { avatar: sessionUser.image }),
        iamId: sessionUser.id,
        updatedAt: new Date(),
        ...processedAdditionalData,
      };

      // Build the update query
      const updateQuery: Record<string, any> = {
        $set: updateData,
      };

      // Only set defaults on insert (new user)
      if (!existingUser) {
        updateQuery.$setOnInsert = {
          createdAt: new Date(),
          roles: [],
        };
      }

      const result = await userCollection.findOneAndUpdate(
        {
          $or: [{ email: sessionUser.email }, { iamId: sessionUser.id }],
        },
        updateQuery,
        {
          returnDocument: 'after',
          upsert: true,
        },
      );

      return result as null | SyncedUserDocument;
    } catch (error) {
      this.logger.error(`Error syncing Better-Auth user: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  // ===================================================================================================================
  // Email Sync
  // ===================================================================================================================

  /**
   * Syncs an email change from Legacy Auth to Better-Auth (IAM)
   *
   * When a user changes their email in Legacy Auth, this method updates:
   * 1. The email field in the shared users collection (already done by Legacy)
   * 2. The Better-Auth session data (if any active sessions exist)
   *
   * Note: Since we share the 'users' collection, the email is already updated.
   * This method handles any additional Better-Auth specific updates.
   *
   * @param oldEmail - The user's previous email address
   * @param newEmail - The user's new email address
   * @returns true if sync was successful, false otherwise
   */
  async syncEmailChangeFromLegacy(oldEmail: string, newEmail: string): Promise<boolean> {
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot sync email change');
      return false;
    }

    try {
      const sessionCollection = this.connection.collection('session');

      // Find user by new email (already updated by Legacy Auth), fallback to old email
      const usersCollection = this.connection.collection('users');
      const user = await usersCollection.findOne({
        $or: [{ email: newEmail }, { email: oldEmail }],
      });

      if (!user) {
        return false;
      }

      // Invalidate all existing sessions for this user
      // This forces re-authentication with the new email
      if (user._id) {
        await sessionCollection.deleteMany({ userId: user._id });
        this.logger.debug(`Invalidated sessions for email change: ${maskEmail(oldEmail)} → ${maskEmail(newEmail)}`);
      }

      return true;
    } catch (error) {
      this.logger.error(
        `Error syncing email change from Legacy: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  /**
   * Syncs an email change from Better-Auth (IAM) to Legacy Auth
   *
   * When a user changes their email in Better-Auth, this method:
   * 1. Updates the email in the shared users collection
   * 2. Invalidates any legacy refresh tokens (forces re-authentication)
   *
   * @param userId - The Better-Auth user ID (iamId)
   * @param newEmail - The user's new email address
   * @returns true if sync was successful, false otherwise
   */
  async syncEmailChangeFromIam(userId: string, newEmail: string): Promise<boolean> {
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot sync email change');
      return false;
    }

    try {
      const usersCollection = this.connection.collection('users');

      // Find user by iamId and update email
      const result = await usersCollection.findOneAndUpdate(
        { $or: [{ iamId: userId }, { id: userId }] },
        {
          $set: {
            email: newEmail,
            // Clear refresh tokens to force re-authentication
            refreshTokens: {},
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' },
      );

      return !!result;
    } catch (error) {
      this.logger.error(
        `Error syncing email change from IAM: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  // ===================================================================================================================
  // User Deletion
  // ===================================================================================================================

  /**
   * Deletes a user from both Legacy Auth and Better-Auth (IAM) systems
   *
   * This method performs cascading deletion:
   * 1. Deletes the user from the shared users collection
   * 2. Deletes all Better-Auth accounts for this user
   * 3. Deletes all Better-Auth sessions for this user
   *
   * @param userIdentifier - Email, MongoDB _id, or iamId of the user
   * @returns Object with deletion results
   */
  async deleteUserFromBothSystems(userIdentifier: string): Promise<{
    accountsDeleted: number;
    sessionsDeleted: number;
    success: boolean;
    userDeleted: boolean;
  }> {
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot delete user');
      return { accountsDeleted: 0, sessionsDeleted: 0, success: false, userDeleted: false };
    }

    try {
      const usersCollection = this.connection.collection('users');
      const accountCollection = this.connection.collection('account');
      const sessionCollection = this.connection.collection('session');

      // Find the user first to get all identifiers
      let user: any = null;

      // Try to find by email first
      user = await usersCollection.findOne({ email: userIdentifier });

      // Try by iamId
      if (!user) {
        user = await usersCollection.findOne({ iamId: userIdentifier });
      }

      // Try by MongoDB _id
      if (!user && ObjectId.isValid(userIdentifier)) {
        user = await usersCollection.findOne({ _id: new ObjectId(userIdentifier) });
      }

      if (!user) {
        return { accountsDeleted: 0, sessionsDeleted: 0, success: false, userDeleted: false };
      }

      const userId = user._id as ObjectId;

      // Delete Better-Auth sessions
      const sessionsResult = await sessionCollection.deleteMany({ userId });
      const sessionsDeleted = sessionsResult.deletedCount;

      // Delete Better-Auth accounts
      const accountsResult = await accountCollection.deleteMany({ userId });
      const accountsDeleted = accountsResult.deletedCount;

      // Delete the user document
      const userResult = await usersCollection.deleteOne({ _id: userId });
      const userDeleted = userResult.deletedCount > 0;

      this.logger.log(
        `Deleted user ${user.email}: user=${userDeleted}, accounts=${accountsDeleted}, sessions=${sessionsDeleted}`,
      );

      return {
        accountsDeleted,
        sessionsDeleted,
        success: userDeleted,
        userDeleted,
      };
    } catch (error) {
      this.logger.error(`Error deleting user: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { accountsDeleted: 0, sessionsDeleted: 0, success: false, userDeleted: false };
    }
  }

  /**
   * Cleans up Better-Auth data when a user is deleted from Legacy Auth
   *
   * Call this method when a user is deleted through Legacy Auth to ensure
   * all Better-Auth related data is also removed.
   *
   * @param userId - MongoDB _id of the deleted user
   * @returns Object with deletion results
   */
  async cleanupIamDataForDeletedUser(userId: ObjectId | string): Promise<{
    accountsDeleted: number;
    sessionsDeleted: number;
    success: boolean;
  }> {
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot cleanup IAM data');
      return { accountsDeleted: 0, sessionsDeleted: 0, success: false };
    }

    try {
      const accountCollection = this.connection.collection('account');
      const sessionCollection = this.connection.collection('session');

      const userObjectId = typeof userId === 'string' ? new ObjectId(userId) : userId;

      // Delete Better-Auth sessions
      const sessionsResult = await sessionCollection.deleteMany({ userId: userObjectId });
      const sessionsDeleted = sessionsResult.deletedCount;

      // Delete Better-Auth accounts
      const accountsResult = await accountCollection.deleteMany({ userId: userObjectId });
      const accountsDeleted = accountsResult.deletedCount;

      return {
        accountsDeleted,
        sessionsDeleted,
        success: true,
      };
    } catch (error) {
      this.logger.error(`Error cleaning up IAM data: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { accountsDeleted: 0, sessionsDeleted: 0, success: false };
    }
  }

  /**
   * Cleans up Legacy Auth data when a user is deleted from Better-Auth (IAM)
   *
   * Call this method when a user is deleted through Better-Auth to ensure
   * the Legacy Auth user is also removed.
   *
   * @param iamUserId - Better-Auth user ID (iamId)
   * @returns true if cleanup was successful, false otherwise
   */
  async cleanupLegacyDataForDeletedIamUser(iamUserId: string): Promise<boolean> {
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot cleanup Legacy data');
      return false;
    }

    try {
      const usersCollection = this.connection.collection('users');

      // Delete the user from Legacy Auth
      const result = await usersCollection.deleteOne({
        $or: [{ iamId: iamUserId }, { id: iamUserId }],
      });

      return result.deletedCount > 0;
    } catch (error) {
      this.logger.error(`Error cleaning up Legacy data: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  // ===================================================================================================================
  // Migration Status
  // ===================================================================================================================

  /**
   * Gets the migration status from Legacy Auth to Better-Auth (IAM)
   *
   * This method provides administrators with information about how many users
   * have been migrated to the IAM system, helping them determine when it's
   * safe to consider disabling Legacy Auth.
   *
   * A user is considered fully migrated when:
   * 1. They have an `iamId` set (linked to Better-Auth user table)
   * 2. They have a credential account in the `account` collection
   *
   * @returns Migration status object with counts and percentage
   */
  async getMigrationStatus(): Promise<MigrationStatus> {
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot get migration status');
      return {
        canDisableLegacyAuth: false,
        fullyMigratedUsers: 0,
        migrationPercentage: 0,
        pendingMigrationUsers: 0,
        pendingUserEmails: [],
        totalUsers: 0,
        usersWithIamAccount: 0,
        usersWithIamId: 0,
      };
    }

    try {
      const usersCollection = this.connection.collection('users');
      const accountCollection = this.connection.collection('account');

      // Get total user count
      const totalUsers = await usersCollection.countDocuments({});

      // Get users with iamId set
      const usersWithIamId = await usersCollection.countDocuments({
        iamId: { $exists: true, $ne: null },
      });

      // Get unique userIds that have credential accounts
      const credentialAccounts = await accountCollection
        .aggregate([{ $match: { providerId: 'credential' } }, { $group: { _id: '$userId' } }])
        .toArray();
      const usersWithIamAccount = credentialAccounts.length;

      // Get users that are fully migrated (have both iamId AND credential account)
      // We need to find users where iamId exists AND there's a matching account
      const usersWithBoth = await usersCollection
        .aggregate([
          {
            $match: {
              iamId: { $exists: true, $ne: null },
            },
          },
          {
            $lookup: {
              as: 'accounts',
              foreignField: 'userId',
              from: 'account',
              localField: '_id',
            },
          },
          {
            $match: {
              'accounts.providerId': 'credential',
            },
          },
          {
            $count: 'count',
          },
        ])
        .toArray();
      const fullyMigratedUsers = usersWithBoth[0]?.count || 0;

      // Calculate pending users
      const pendingMigrationUsers = totalUsers - fullyMigratedUsers;

      // Calculate percentage
      const migrationPercentage = totalUsers > 0 ? Math.round((fullyMigratedUsers / totalUsers) * 100 * 100) / 100 : 0;

      // Get emails of pending users (limit to 100)
      const pendingUsers = await usersCollection
        .aggregate([
          {
            $lookup: {
              as: 'accounts',
              foreignField: 'userId',
              from: 'account',
              localField: '_id',
            },
          },
          {
            $match: {
              $or: [
                { iamId: { $exists: false } },
                { iamId: null },
                {
                  $and: [{ iamId: { $exists: true, $ne: null } }, { 'accounts.providerId': { $ne: 'credential' } }],
                },
              ],
            },
          },
          { $limit: 100 },
          { $project: { email: 1 } },
        ])
        .toArray();
      const pendingUserEmails = pendingUsers.map((u) => u.email).filter(Boolean);

      // Can disable legacy auth only if ALL users are fully migrated
      const canDisableLegacyAuth = totalUsers > 0 && fullyMigratedUsers === totalUsers;

      return {
        canDisableLegacyAuth,
        fullyMigratedUsers,
        migrationPercentage,
        pendingMigrationUsers,
        pendingUserEmails,
        totalUsers,
        usersWithIamAccount,
        usersWithIamId,
      };
    } catch (error) {
      this.logger.error(`Error getting migration status: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        canDisableLegacyAuth: false,
        fullyMigratedUsers: 0,
        migrationPercentage: 0,
        pendingMigrationUsers: 0,
        pendingUserEmails: [],
        totalUsers: 0,
        usersWithIamAccount: 0,
        usersWithIamId: 0,
      };
    }
  }
}
