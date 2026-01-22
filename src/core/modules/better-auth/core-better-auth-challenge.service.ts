import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import * as crypto from 'crypto';
import { Collection, Document } from 'mongodb';
import { Connection } from 'mongoose';

import { IBetterAuth } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';

/**
 * WebAuthn challenge mapping document structure.
 *
 * This stores a mapping from our challengeId to Better Auth's verificationToken.
 * Better Auth stores the actual challenge in its verification collection.
 */
interface WebAuthnChallengeMappingDocument extends Document {
  /** Our unique challenge ID (returned to client) */
  challengeId: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Expiration timestamp (TTL index) */
  expiresAt: Date;
  /** Type of operation */
  type: 'authentication' | 'registration';
  /** User ID this challenge belongs to */
  userId: string;
  /** Better Auth's verification token (from their cookie) */
  verificationToken: string;
}

/**
 * Service for managing WebAuthn challenge mappings in MongoDB.
 *
 * This service provides an alternative to cookie-based challenge storage,
 * enabling Passkey authentication in JWT-only (cookieless) mode.
 *
 * ## How it works (Adapter approach):
 * 1. When `generateRegisterOptions` or `generateAuthenticateOptions` is called,
 *    Better Auth stores its verificationToken in a cookie and the challenge in its DB
 * 2. We extract the verificationToken from the Set-Cookie header
 * 3. We store a mapping: challengeId → verificationToken in our collection
 * 4. We return challengeId to the client (not the verificationToken for security)
 * 5. When `verifyRegistration` or `verifyAuthentication` is called,
 *    we inject the verificationToken as a cookie so Better Auth can find the challenge
 *
 * ## Why this approach?
 * - Better Auth stores challenges in its `verification` collection using verificationToken as key
 * - We don't duplicate the challenge storage, we just bridge the cookie gap
 * - Full compatibility with Better Auth updates
 * - Better Auth handles all WebAuthn logic natively
 *
 * ## Security considerations:
 * - Challenges expire automatically via MongoDB TTL index
 * - Each challengeId can only be used once (deleted after use)
 * - verificationToken is never exposed to the client (only challengeId)
 * - Challenges are bound to a specific user
 */
@Injectable()
export class CoreBetterAuthChallengeService implements OnModuleInit {
  private readonly logger = new Logger(CoreBetterAuthChallengeService.name);
  private collection: Collection<WebAuthnChallengeMappingDocument> | null = null;
  private ttlSeconds: number = 300; // 5 minutes default
  private enabled: boolean = false;

  constructor(
    @Optional() @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  /**
   * Initialize the collection and ensure TTL index exists
   */
  async onModuleInit() {
    // ConfigService may not be available in test environments
    if (!this.configService) {
      return;
    }

    // Read config in onModuleInit to ensure it's fully loaded
    const config = this.configService.get<IBetterAuth>('betterAuth') || {};
    const passkeyConfig = typeof config.passkey === 'object' ? config.passkey : null;

    // Database challenge storage is the default because:
    // 1. Works everywhere (same-origin, cross-origin, JWT mode)
    // 2. No cookie handling issues
    // 3. Enables cookieless passkey authentication
    //
    // Disable database storage when:
    // - Passkey is explicitly disabled (passkey: false OR passkey: { enabled: false })
    // - Cookie storage is explicitly configured (passkey.challengeStorage: 'cookie')
    const isPasskeyDisabled = config.passkey === false || passkeyConfig?.enabled === false;
    const useCookieStorage = passkeyConfig?.challengeStorage === 'cookie';

    this.enabled = !isPasskeyDisabled && !useCookieStorage;

    if (useCookieStorage) {
      this.logger.log('Using cookie-based challenge storage (explicitly configured)');
    }
    this.ttlSeconds = passkeyConfig?.challengeTtlSeconds || 300;

    if (!this.enabled) {
      return;
    }

    try {
      if (!this.connection) {
        this.logger.warn('MongoDB connection not available, challenge storage disabled');
        this.enabled = false;
        return;
      }

      const db = this.connection.db;
      if (!db) {
        this.logger.warn('Database not available, challenge storage disabled');
        this.enabled = false;
        return;
      }

      // Get or create the collection
      this.collection = db.collection<WebAuthnChallengeMappingDocument>('webauthn_challenge_mappings');

      // Ensure TTL index exists for automatic cleanup
      await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

      // Index for fast lookups
      await this.collection.createIndex({ challengeId: 1 }, { unique: true });
      await this.collection.createIndex({ verificationToken: 1 });

      this.logger.log('WebAuthn challenge storage initialized (database mode)');
    } catch (error) {
      this.logger.error(`Failed to initialize challenge storage: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if database challenge storage is enabled
   */
  isEnabled(): boolean {
    return this.enabled && this.collection !== null;
  }

  /**
   * Store a mapping from challengeId to Better Auth's verificationToken.
   *
   * @param verificationToken - Better Auth's verification token from the cookie
   * @param userId - User ID this challenge belongs to
   * @param type - Type of operation (registration or authentication)
   * @returns Challenge ID to be passed to the client
   */
  async storeChallengeMapping(
    verificationToken: string,
    userId: string,
    type: 'authentication' | 'registration',
  ): Promise<string> {
    if (!this.collection) {
      throw new Error('Challenge storage not initialized');
    }

    // Generate a unique challenge ID for the client
    const challengeId = crypto.randomBytes(32).toString('base64url');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);

    await this.collection.insertOne({
      challengeId,
      createdAt: now,
      expiresAt,
      type,
      userId,
      verificationToken,
    } as WebAuthnChallengeMappingDocument);

    this.logger.debug(`Stored ${type} challenge mapping for user ${userId.substring(0, 8)}...`);

    return challengeId;
  }

  /**
   * Retrieve the verificationToken for a given challengeId.
   *
   * @param challengeId - The challenge ID returned from storeChallengeMapping
   * @returns The verificationToken or null if not found/expired
   */
  async getVerificationToken(challengeId: string): Promise<null | string> {
    if (!this.collection) {
      return null;
    }

    const doc = await this.collection.findOne({ challengeId });

    if (!doc) {
      this.logger.debug(`Challenge mapping not found: ${challengeId.substring(0, 8)}...`);
      return null;
    }

    // Check if expired (shouldn't happen with TTL, but double-check)
    if (doc.expiresAt < new Date()) {
      this.logger.debug(`Challenge mapping expired: ${challengeId.substring(0, 8)}...`);
      return null;
    }

    return doc.verificationToken;
  }

  /**
   * Delete a challenge mapping (after use or on error)
   *
   * @param challengeId - The challenge ID to delete
   */
  async deleteChallengeMapping(challengeId: string): Promise<void> {
    if (!this.collection) {
      return;
    }

    await this.collection.deleteOne({ challengeId });
    this.logger.debug(`Deleted challenge mapping: ${challengeId.substring(0, 8)}...`);
  }

  /**
   * Delete all challenge mappings for a user (e.g., on logout or account deletion)
   *
   * @param userId - User ID whose challenge mappings should be deleted
   */
  async deleteUserChallengeMappings(userId: string): Promise<void> {
    if (!this.collection) {
      return;
    }

    const result = await this.collection.deleteMany({ userId });
    if (result.deletedCount > 0) {
      this.logger.debug(`Deleted ${result.deletedCount} challenge mappings for user ${userId.substring(0, 8)}...`);
    }
  }

  /**
   * Get the TTL in seconds for challenge mappings
   */
  getTtlSeconds(): number {
    return this.ttlSeconds;
  }

  /**
   * Get the cookie name used by Better Auth for passkey challenges
   */
  getCookieName(): string {
    if (!this.configService) {
      return 'better-auth.better-auth-passkey';
    }
    const config = this.configService.get<IBetterAuth>('betterAuth') || {};
    const passkeyConfig = typeof config.passkey === 'object' ? config.passkey : null;
    return passkeyConfig?.webAuthnChallengeCookie || 'better-auth.better-auth-passkey';
  }
}
