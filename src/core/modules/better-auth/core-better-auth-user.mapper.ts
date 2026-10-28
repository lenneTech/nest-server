import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { randomBytes, scrypt, ScryptOptions } from 'crypto';
import { sha256 } from 'js-sha256';
import { ObjectId } from 'mongodb';
import type { Connection } from 'mongoose';

// Promisify Node.js crypto.scrypt
const scryptPromise = (password: string, salt: string, keylen: number, options: ScryptOptions): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
};

import { RoleEnum } from '../../common/enums/role.enum.js';
import { maskEmail } from '../../common/helpers/logging.helper.js';
import { legacyCredentialAccountIssuer } from './core-better-auth-account-issuer.helper.js';
import { getBetterAuthSqlStore } from './core-better-auth-sql.registry.js';
import type { BetterAuthSqlStore } from './core-better-auth-sql.store.js';

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
 * Options for {@link CoreBetterAuthUserMapper.getMigrationStatus}.
 */
export interface GetMigrationStatusOptions {
  /**
   * Whether to collect `pendingUserEmails` (up to 100 addresses).
   *
   * Costs two extra collection-scale queries, one of them a guaranteed COLLSCAN. Pass `false`
   * from callers that only need the counts — they get the same numbers without the scan, and
   * without handling addresses they were going to discard.
   *
   * @default true
   */
  includePendingEmails?: boolean;
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
/**
 * Cached user data for mapSessionUser (lightweight: only the fields needed for MappedUser)
 */
interface CachedUserData {
  expiresAt: number;
  id: string;
  roles: string[];
  verified: boolean;
}

/**
 * Whether an error means the application closed its own database connection under a running query.
 *
 * Matched by `name`, not `instanceof`: a project may resolve a second copy of the driver, and the name is
 * the driver's documented discriminator for both classes.
 */
function isClosedConnectionError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'MongoClientClosedError' || name === 'MongoTopologyClosedError';
}

@Injectable()
export class CoreBetterAuthUserMapper {
  private readonly logger = new Logger(CoreBetterAuthUserMapper.name);

  /**
   * Lightweight TTL cache for user DB lookups.
   * Key: iamId (BetterAuth user ID), Value: minimal user data (id, roles, verified).
   * Only caches ~100 bytes per entry (no full documents). Max 500 entries = ~50KB.
   */
  private readonly userCache = new Map<string, CachedUserData>();
  private static readonly USER_CACHE_MAX = 500;

  /**
   * Cache TTL: 15s in production, disabled in test / lt dev environments.
   *
   * `PLAYWRIGHT` and `LT_DEV_ACTIVE` (exported by `lt dev up`) join `VITEST`
   * and the test NODE_ENVs so that E2E suites — which promote a freshly
   * signed-up user to admin via a direct DB write — always read the user's
   * current roles instead of a stale 15s-cached copy.
   */
  private static readonly USER_CACHE_TTL_MS =
    process.env.VITEST === 'true' ||
    process.env.PLAYWRIGHT === 'true' ||
    process.env.LT_DEV_ACTIVE === 'true' ||
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'e2e'
      ? 0
      : 15_000;

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
    const sql = getBetterAuthSqlStore();
    if (!this.connection && !sql) {
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
      // Check lightweight cache first (only stores id, roles, verified — ~100 bytes per entry)
      const ttl = CoreBetterAuthUserMapper.USER_CACHE_TTL_MS;
      const now = Date.now();
      const cached = ttl > 0 ? this.userCache.get(sessionUser.id) : undefined;
      if (cached && now < cached.expiresAt) {
        return this.createMappedUser({
          email: sessionUser.email,
          emailVerified: sessionUser.emailVerified,
          iamId: sessionUser.id,
          id: cached.id,
          image: sessionUser.image,
          name: sessionUser.name,
          roles: cached.roles,
          verified: cached.verified,
        });
      }

      // Look up the user in our database by email OR iamId
      // This ensures we find the user regardless of which system they signed up with
      // (on SQL, Better-Auth's user id IS the row's id — one row per user)
      const dbUser = sql
        ? await sql.findUser({ email: sessionUser.email, iamId: sessionUser.id, id: sessionUser.id })
        : await this.connection?.collection('users').findOne({
            $or: [{ email: sessionUser.email }, { iamId: sessionUser.id }],
          });

      if (dbUser) {
        // User exists in our database - use their roles and verified status
        const roles = Array.isArray(dbUser.roles) ? dbUser.roles : [];
        // Use database verified status, fallback to Better-Auth emailVerified
        const verified = dbUser.verified === true || sessionUser.emailVerified === true;

        // Cache only the minimal data needed (not the full document)
        if (CoreBetterAuthUserMapper.USER_CACHE_TTL_MS > 0) {
          this.cacheUserData(sessionUser.id, { id: String(dbUser._id ?? dbUser.id), roles, verified });
        }

        return this.createMappedUser({
          email: sessionUser.email,
          emailVerified: sessionUser.emailVerified,
          iamId: sessionUser.id,
          id: String(dbUser._id ?? dbUser.id),
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
      // Bind to static method to avoid creating a new closure per request
      hasRole: CoreBetterAuthUserMapper.createHasRole(roles, userData.verified === true),
      roles,
    };
  }

  /**
   * Creates a hasRole function. Uses a shared factory to minimize per-request closure size.
   * The returned function only captures `roles` (string[]) and `verified` (boolean) — no large objects.
   */
  private static createHasRole(roles: string[], verified: boolean): (checkRoles: string | string[]) => boolean {
    return (checkRoles: string | string[]): boolean => {
      const rolesToCheck = Array.isArray(checkRoles) ? checkRoles : [checkRoles];

      if (rolesToCheck.includes(RoleEnum.S_EVERYONE)) return true;
      if (rolesToCheck.includes(RoleEnum.S_USER)) return true;
      if (rolesToCheck.includes(RoleEnum.S_NO_ONE)) return false;
      if (rolesToCheck.includes(RoleEnum.S_VERIFIED)) return verified;

      return rolesToCheck.some((role) => roles.includes(role));
    };
  }

  /**
   * Store minimal user data in the lightweight cache.
   * Only stores id, roles, verified — no full documents or large objects.
   */
  private cacheUserData(iamId: string, data: Omit<CachedUserData, 'expiresAt'>): void {
    // Evict oldest if at capacity (simple FIFO)
    if (this.userCache.size >= CoreBetterAuthUserMapper.USER_CACHE_MAX) {
      const firstKey = this.userCache.keys().next().value;
      if (firstKey) this.userCache.delete(firstKey);
    }
    this.userCache.set(iamId, {
      ...data,
      expiresAt: Date.now() + CoreBetterAuthUserMapper.USER_CACHE_TTL_MS,
    });
  }

  /**
   * Invalidate cached user data. Call when user roles or verified status change.
   * Called automatically from `CoreUserService.setRoles()` and `CoreUserService.update()`.
   *
   * @param iamId - The BetterAuth user ID (from session/account, not MongoDB _id)
   */
  invalidateUserCache(iamId: string): void {
    this.userCache.delete(iamId);
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
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.syncPasswordToLegacyOnSql(sql, iamUserId, userEmail, plainPassword);
    }
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
      // `$or` across two different indexes (`users.email` unique, `users.iamId` sparse) forces an
      // index-union plan rather than a single-index point lookup. Deliberate — the caller may know
      // only one of the two — and irrelevant at password-change frequency. It would NOT be
      // irrelevant in a bulk or migration loop; anything calling this in one should look up the
      // user once and address it by `_id`.
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
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.syncPasswordChangeToIamOnSql(sql, userEmail, plainPassword);
    }
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
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.migrateAccountToIamOnSql(sql, userEmail, plainPassword);
    }
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

      // Better-Auth stores account.userId as ObjectId that references users._id
      const userMongoId = legacyUser._id as ObjectId;

      // FAST PATH: Check if credential account already exists BEFORE expensive bcrypt
      // For already-migrated users this avoids ~130ms of bcrypt.compare() per sign-in
      const existingAccount = await accountsCollection.findOne({
        providerId: 'credential',
        userId: userMongoId,
      });

      if (existingAccount) {
        return true;
      }

      // No password provided - cannot verify, cannot migrate
      if (!plainPassword) {
        return false;
      }

      // IMPORTANT: Verify the provided password matches the legacy hash
      // This prevents migration with a wrong password
      // Legacy Auth uses two formats for backwards compatibility:
      // 1. bcrypt(password) - direct hash
      // 2. bcrypt(sha256(password)) - sha256 then bcrypt
      const directMatch = await bcrypt.compare(plainPassword, legacyUser.password);
      const sha256Match = !directMatch ? await bcrypt.compare(sha256(plainPassword), legacyUser.password) : false;
      if (!directMatch && !sha256Match) {
        // Security: Wrong password provided for migration - reject
        this.logger.warn(`Migration password verification failed for ${maskEmail(userEmail)}`);
        return false;
      }

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

      // Create the credential account with Better-Auth compatible scrypt hash
      const passwordHash = await this.hashPasswordForBetterAuth(plainPassword);

      const now = new Date();
      // Store account matching Better-Auth's format:
      // - userId: ObjectId referencing users._id
      // - accountId: string version of users._id
      // - issuer: ONLY while the installed better-auth is 1.7.0–1.7.2, which key accounts by
      //   (issuer, accountId) — a row without it is not found, and the migrated user gets a 401 on
      //   the very sign-in that triggered the migration. 1.7.3+ went back to (providerId,
      //   accountId) and writes no issuer. Always derived from the helper, never hand-written.
      const credentialIssuer = legacyCredentialAccountIssuer();
      await accountsCollection.insertOne({
        accountId: userIdHex,
        createdAt: now,
        id: this.generateId(),
        ...(credentialIssuer ? { issuer: credentialIssuer } : {}),
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
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.linkOrCreateUserOnSql(sql, sessionUser, additionalData);
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

      const updateData = this.linkedUserFields(sessionUser, existingUser, additionalData);

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

  /**
   * The fields `linkOrCreateUser()` writes onto the app user, on MongoDB and on SQL alike
   */
  protected linkedUserFields(
    sessionUser: BetterAuthSessionUser,
    existingUser: null | Record<string, any> | undefined,
    additionalData?: Record<string, any>,
  ): Record<string, any> {
    // Process additionalData to convert termsAndPrivacyAccepted to timestamp
    const processedAdditionalData = { ...additionalData };
    if (processedAdditionalData?.termsAndPrivacyAccepted === true) {
      processedAdditionalData.termsAndPrivacyAcceptedAt = new Date();
      delete processedAdditionalData.termsAndPrivacyAccepted;
    } else {
      delete processedAdditionalData?.termsAndPrivacyAccepted;
    }

    // Reverse-sync the Better-Auth name into firstName/lastName ONLY when it actually
    // differs from the stored combination. The split is lossy (first word vs. rest), so an
    // unconditional overwrite would clobber locally maintained names on EVERY sign-in —
    // e.g. firstName "Anna Maria" / lastName "von Berg" would mutate to "Anna" / "Maria von
    // Berg" although nothing changed on the Better-Auth side.
    const existingFullName = [existingUser?.firstName, existingUser?.lastName].filter(Boolean).join(' ');
    const nameChangedInIam = !!sessionUser.name && sessionUser.name !== existingFullName;

    return {
      email: sessionUser.email,
      ...(sessionUser.name && nameChangedInIam && { firstName: sessionUser.name.split(' ')[0] }),
      ...(sessionUser.name &&
        nameChangedInIam &&
        sessionUser.name.includes(' ') && {
          lastName: sessionUser.name.split(' ').slice(1).join(' '),
        }),
      ...(sessionUser.emailVerified !== undefined && { verified: sessionUser.emailVerified }),
      // Deliberately NOT `avatar: sessionUser.image`. `image` is a Better-Auth BUILT-IN column,
      // so it is client-writable through `POST /iam/update-user` — it is not covered by
      // PROTECTED_INPUT_FALSE_KEYS, which only locks the fields this framework adds. Copying it
      // here wrote an attacker-chosen value into `avatar` through a NATIVE driver update, past
      // both the `S_NO_ONE` input restriction on the field and every Mongoose plugin. Since the
      // avatar endpoint deletes the file the previous value points at, that turned "set your own
      // image" into "delete any file in the store". The avatar upload is the only writer.
      iamId: sessionUser.id,
      updatedAt: new Date(),
      ...processedAdditionalData,
    };
  }

  // ===================================================================================================================
  // Name Sync
  // ===================================================================================================================

  /**
   * Syncs a name change from Legacy Auth to Better-Auth (IAM)
   *
   * When a user changes their firstName/lastName in Legacy Auth (e.g. via PATCH /users/:id),
   * the Better-Auth `name` field on the shared users document must follow. Without this sync,
   * the next sign-in reverse-syncs the STALE Better-Auth name back into firstName/lastName
   * (see linkOrCreateUser), silently discarding the user's edit.
   *
   * @param userEmail - The user's current email address (lookup key on the shared collection)
   * @param name - The new display name (typically `firstName lastName`). May be empty: a cleared
   *   name must reach the Better-Auth side too, or the next sign-in writes the old one back.
   * @returns true if sync was successful, false otherwise
   */
  async syncNameChangeFromLegacy(userEmail: string, name: string): Promise<boolean> {
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.syncNameChangeFromLegacyOnSql(sql, userEmail, name);
    }
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot sync name change');
      return false;
    }

    try {
      const usersCollection = this.connection.collection('users');
      const result = await usersCollection.updateOne({ email: userEmail }, { $set: { name, updatedAt: new Date() } });
      if (result.matchedCount === 0) {
        return false;
      }
      this.logger.debug(`Synced name change from Legacy to IAM for ${maskEmail(userEmail)}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Error syncing name change from Legacy: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
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
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.syncEmailChangeFromLegacyOnSql(sql, oldEmail, newEmail);
    }
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
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.syncEmailChangeFromIamOnSql(sql, userId, newEmail);
    }
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
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.deleteUserFromBothSystemsOnSql(sql, userIdentifier);
    }
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
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.cleanupIamDataForDeletedUserOnSql(sql, String(userId));
    }
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
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.cleanupLegacyDataForDeletedIamUserOnSql(sql, iamUserId);
    }
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
  async getMigrationStatus(options?: GetMigrationStatusOptions): Promise<MigrationStatus> {
    // Building `pendingUserEmails` costs two collection-scale queries, one of them a
    // guaranteed COLLSCAN (`$exists: false` cannot use the sparse `iamId` index) that scans
    // the WHOLE collection precisely in the all-migrated steady state, where it finds nothing.
    // A caller that only needs the counts — the boot-time deprecation warning does — should
    // not pay for a field it discards.
    const includePendingEmails = options?.includePendingEmails !== false;
    const sql = getBetterAuthSqlStore();
    if (sql) {
      return this.getMigrationStatusOnSql(sql, includePendingEmails);
    }
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
      // Counted server-side. The previous form materialized one `{_id}` object per distinct
      // migrated user in the Node heap only to read `.length` — an allocation that grows with
      // the user count, at boot, before the first request.
      const credentialAccountCount = await accountCollection
        .aggregate([{ $match: { providerId: 'credential' } }, { $group: { _id: '$userId' } }, { $count: 'count' }])
        .toArray();
      const usersWithIamAccount = credentialAccountCount[0]?.count ?? 0;

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
      // Two-phase approach: first get users without iamId (no $lookup needed),
      // then check users with iamId but missing credential account
      const usersWithoutIamId = !includePendingEmails
        ? []
        : await usersCollection
            .find({ $or: [{ iamId: { $exists: false } }, { iamId: null }] })
            .limit(100)
            .project({ email: 1 })
            .toArray();

      const remaining = 100 - usersWithoutIamId.length;
      let usersWithIamButNoAccount: { email?: string }[] = [];
      if (includePendingEmails && remaining > 0) {
        usersWithIamButNoAccount = await usersCollection
          .aggregate([
            { $match: { iamId: { $exists: true, $ne: null } } },
            {
              $lookup: {
                as: 'accounts',
                foreignField: 'userId',
                from: 'account',
                localField: '_id',
              },
            },
            { $match: { 'accounts.providerId': { $ne: 'credential' } } },
            { $limit: remaining },
            { $project: { email: 1 } },
          ])
          .toArray();
      }

      const pendingUserEmails = [...usersWithoutIamId, ...usersWithIamButNoAccount].map((u) => u.email).filter(Boolean);

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
      if (isClosedConnectionError(error)) {
        // The application is shutting down. The boot-time report of CoreLegacyAuthDeprecationInitializer
        // runs detached on purpose (it must not delay readiness), so a process that closes right after
        // init() — `docs:ci`, a script, a test — closes the connection under it. Nothing failed.
        this.logger.debug('Migration status not read: the database connection was closed (application shutting down)');
      } else {
        this.logger.error(
          `Error getting migration status: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
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

  // ===================================================================================================================
  // SQL data source — Better-Auth and the user model share ONE row per user in `users`, and Better-Auth's user id IS
  // that row's id (see BetterAuthSqlStore). Same behaviour as the MongoDB paths above; only the access differs.
  // ===================================================================================================================

  protected async syncPasswordToLegacyOnSql(
    sql: BetterAuthSqlStore,
    iamUserId: string,
    userEmail: string,
    plainPassword?: string,
  ): Promise<boolean> {
    if (!plainPassword) {
      return false;
    }
    try {
      // bcrypt(sha256(password)), as on MongoDB; the password policy keeps a bcrypt value as it is
      const bcryptHash = await bcrypt.hash(this.normalizePasswordForIam(plainPassword), 10);
      return !!(await sql.updateUser({ email: userEmail, iamId: iamUserId }, { password: bcryptHash }));
    } catch (error) {
      this.logger.error(
        `Error syncing password to legacy: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  protected async syncPasswordChangeToIamOnSql(
    sql: BetterAuthSqlStore,
    userEmail: string,
    plainPassword: string,
  ): Promise<boolean> {
    if (!plainPassword) {
      return false;
    }
    try {
      const user = await sql.findUser({ email: userEmail });
      if (!user || !(await sql.findCredentialAccount(user.id))) {
        return false;
      }
      await sql.updateCredentialPassword(user.id, await this.hashPasswordForBetterAuth(plainPassword));
      return true;
    } catch (error) {
      this.logger.error(`Error syncing password to IAM: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  protected async migrateAccountToIamOnSql(
    sql: BetterAuthSqlStore,
    userEmail: string,
    plainPassword?: string,
  ): Promise<boolean> {
    try {
      const legacyUser = await sql.findUser({ email: userEmail });
      if (!legacyUser?.password) {
        return false;
      }
      // FAST PATH, as on MongoDB: an existing credential account means the user is migrated already
      if (await sql.findCredentialAccount(legacyUser.id)) {
        return true;
      }
      if (!plainPassword) {
        return false;
      }
      const directMatch = await bcrypt.compare(plainPassword, legacyUser.password);
      const sha256Match = !directMatch ? await bcrypt.compare(sha256(plainPassword), legacyUser.password) : false;
      if (!directMatch && !sha256Match) {
        this.logger.warn(`Migration password verification failed for ${maskEmail(userEmail)}`);
        return false;
      }
      if (!legacyUser.iamId) {
        // The row IS Better-Auth's user already: link it by its own id instead of minting a second one
        await sql.updateUser({ id: legacyUser.id }, { iamId: legacyUser.id });
        await sql.updateIamUser(legacyUser.id, {
          emailVerified: legacyUser.verified === true,
          name: [legacyUser.firstName, legacyUser.lastName].filter(Boolean).join(' ') || undefined,
        });
      }
      const credentialIssuer = legacyCredentialAccountIssuer();
      await sql.createAccount({
        accountId: legacyUser.id,
        ...(credentialIssuer ? { issuer: credentialIssuer } : {}),
        password: await this.hashPasswordForBetterAuth(plainPassword),
        providerId: 'credential',
        userId: legacyUser.id,
      });
      return true;
    } catch (error) {
      this.logger.error(`Error migrating account to IAM: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  protected async linkOrCreateUserOnSql(
    sql: BetterAuthSqlStore,
    sessionUser: BetterAuthSessionUser,
    additionalData?: Record<string, any>,
  ): Promise<null | SyncedUserDocument> {
    try {
      const match = { email: sessionUser.email, iamId: sessionUser.id, id: sessionUser.id };
      const existingUser = await sql.findUser(match);
      if (!existingUser) {
        // Better-Auth writes the row itself (same table): a missing one is a user Better-Auth does not know either
        this.logger.warn(`Better-Auth user ${maskEmail(sessionUser.email)} has no row in the users table`);
        return null;
      }
      const synced = await sql.updateUser(
        { id: existingUser.id },
        this.linkedUserFields(sessionUser, existingUser, additionalData),
      );
      return synced ? ({ ...synced, _id: synced.id } as SyncedUserDocument) : null;
    } catch (error) {
      this.logger.error(`Error syncing Better-Auth user: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  protected async syncNameChangeFromLegacyOnSql(
    sql: BetterAuthSqlStore,
    userEmail: string,
    name: string,
  ): Promise<boolean> {
    try {
      const user = await sql.findUser({ email: userEmail });
      if (!user) {
        return false;
      }
      // `name` is Better-Auth's field, not the user model's: written through Better-Auth's adapter
      await sql.updateIamUser(user.id, { name });
      this.logger.debug(`Synced name change from Legacy to IAM for ${maskEmail(userEmail)}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Error syncing name change from Legacy: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  protected async syncEmailChangeFromLegacyOnSql(
    sql: BetterAuthSqlStore,
    oldEmail: string,
    newEmail: string,
  ): Promise<boolean> {
    try {
      const user = (await sql.findUser({ email: newEmail })) ?? (await sql.findUser({ email: oldEmail }));
      if (!user) {
        return false;
      }
      await sql.deleteSessions(user.id);
      this.logger.debug(`Invalidated sessions for email change: ${maskEmail(oldEmail)} → ${maskEmail(newEmail)}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Error syncing email change from Legacy: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  protected async syncEmailChangeFromIamOnSql(
    sql: BetterAuthSqlStore,
    userId: string,
    newEmail: string,
  ): Promise<boolean> {
    try {
      return !!(await sql.updateUser({ iamId: userId, id: userId }, { email: newEmail, refreshTokens: {} }));
    } catch (error) {
      this.logger.error(
        `Error syncing email change from IAM: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  protected async deleteUserFromBothSystemsOnSql(
    sql: BetterAuthSqlStore,
    userIdentifier: string,
  ): Promise<{ accountsDeleted: number; sessionsDeleted: number; success: boolean; userDeleted: boolean }> {
    try {
      const user =
        (await sql.findUser({ email: userIdentifier })) ??
        (await sql.findUser({ iamId: userIdentifier })) ??
        (await sql.findUser({ id: userIdentifier }));
      if (!user) {
        return { accountsDeleted: 0, sessionsDeleted: 0, success: false, userDeleted: false };
      }
      const sessionsDeleted = await sql.deleteSessions(user.id);
      const accountsDeleted = await sql.deleteAccounts(user.id);
      await sql.deleteUser(user.id);
      this.logger.log(
        `Deleted user ${maskEmail(user.email)}: user=true, accounts=${accountsDeleted}, sessions=${sessionsDeleted}`,
      );
      return { accountsDeleted, sessionsDeleted, success: true, userDeleted: true };
    } catch (error) {
      this.logger.error(`Error deleting user: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { accountsDeleted: 0, sessionsDeleted: 0, success: false, userDeleted: false };
    }
  }

  protected async cleanupIamDataForDeletedUserOnSql(
    sql: BetterAuthSqlStore,
    userId: string,
  ): Promise<{ accountsDeleted: number; sessionsDeleted: number; success: boolean }> {
    try {
      const sessionsDeleted = await sql.deleteSessions(userId);
      const accountsDeleted = await sql.deleteAccounts(userId);
      return { accountsDeleted, sessionsDeleted, success: true };
    } catch (error) {
      this.logger.error(`Error cleaning up IAM data: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { accountsDeleted: 0, sessionsDeleted: 0, success: false };
    }
  }

  protected async cleanupLegacyDataForDeletedIamUserOnSql(
    sql: BetterAuthSqlStore,
    iamUserId: string,
  ): Promise<boolean> {
    try {
      const user = await sql.findUser({ iamId: iamUserId, id: iamUserId });
      if (!user) {
        return false;
      }
      await sql.deleteUser(user.id);
      return true;
    } catch (error) {
      this.logger.error(`Error cleaning up Legacy data: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  protected async getMigrationStatusOnSql(
    sql: BetterAuthSqlStore,
    includePendingEmails: boolean,
  ): Promise<MigrationStatus> {
    try {
      const counts = await sql.migrationCounts(includePendingEmails ? 100 : 0);
      const totalUsers = counts.total;
      const usersWithIamId = counts.withIamId;
      const usersWithIamAccount = counts.withIamAccount;
      const fullyMigratedUsers = counts.fullyMigrated;
      const pendingMigrationUsers = totalUsers - fullyMigratedUsers;
      const migrationPercentage = totalUsers > 0 ? Math.round((fullyMigratedUsers / totalUsers) * 100 * 100) / 100 : 0;
      const pendingUserEmails = counts.pendingEmails;
      return {
        canDisableLegacyAuth: totalUsers > 0 && fullyMigratedUsers === totalUsers,
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
