import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Request } from 'express';
import { importJWK, jwtVerify } from 'jose';
import { Connection } from 'mongoose';

import { isProduction, maskCookieHeader, maskEmail, maskToken } from '../../common/helpers/logging.helper';
import { IBetterAuth } from '../../common/interfaces/server-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { BetterAuthSessionUser } from './better-auth-user.mapper';
import { BetterAuthInstance } from './better-auth.config';
import { BETTER_AUTH_INSTANCE } from './better-auth.module';

/**
 * Result of a session validation
 */
export interface SessionResult {
  session: null | {
    [key: string]: any;
    expiresAt: Date;
    id: string;
    userId: string;
  };
  user: BetterAuthSessionUser | null;
}

/**
 * BetterAuthService provides a NestJS-friendly wrapper around the better-auth instance.
 *
 * This service:
 * - Provides access to the better-auth API
 * - Offers typed methods for common auth operations
 * - Handles the case when better-auth is disabled gracefully
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class MyService {
 *   constructor(private readonly betterAuthService: BetterAuthService) {}
 *
 *   async doSomething() {
 *     if (this.betterAuthService.isEnabled()) {
 *       const api = this.betterAuthService.getApi();
 *       // Use better-auth API
 *     }
 *   }
 * }
 * ```
 */
/**
 * Injection token for resolved BetterAuth configuration
 */
export const BETTER_AUTH_CONFIG = 'BETTER_AUTH_CONFIG';

@Injectable()
export class BetterAuthService {
  private readonly logger = new Logger(BetterAuthService.name);
  private readonly isProd = isProduction();
  private readonly config: IBetterAuth;

  constructor(
    @Optional() @Inject(BETTER_AUTH_INSTANCE) private readonly authInstance: BetterAuthInstance | null,
    @Optional() @InjectConnection() private readonly connection?: Connection,
    @Inject(BETTER_AUTH_CONFIG) @Optional() private readonly resolvedConfig?: IBetterAuth | null,
    // ConfigService is last because it's only needed as fallback when resolvedConfig is not provided
    @Optional() private readonly configService?: ConfigService,
  ) {
    // Use resolvedConfig if provided (has fallback secret applied), otherwise get fresh from ConfigService
    // Better-Auth is enabled by default (zero-config) - only disabled if explicitly set to false
    this.config = this.resolvedConfig || this.configService?.get<IBetterAuth>('betterAuth') || {};
  }

  /**
   * Checks if better-auth is enabled and initialized
   * Returns true only if:
   * 1. The better-auth instance was successfully created (not null/undefined)
   * 2. Better-Auth was not explicitly disabled (enabled !== false)
   *
   * Better-Auth is enabled by default unless explicitly set to enabled: false
   */
  isEnabled(): boolean {
    // First check: authInstance must exist (not null or undefined)
    if (!this.authInstance) {
      return false;
    }
    // Second check: must not be explicitly disabled
    return this.config?.enabled !== false;
  }

  /**
   * Gets the better-auth instance
   * Returns null if better-auth is disabled
   */
  getInstance(): BetterAuthInstance | null {
    return this.authInstance ?? null;
  }

  /**
   * Gets the better-auth API for direct access to endpoints
   * Returns null if better-auth is disabled
   */
  getApi(): BetterAuthInstance['api'] | null {
    return this.authInstance?.api || null;
  }

  /**
   * Gets the current better-auth configuration
   */
  getConfig(): IBetterAuth {
    return this.config;
  }

  /**
   * Checks if JWT plugin is enabled.
   * JWT is enabled by default when BetterAuth is enabled.
   * Only returns false if explicitly disabled:
   * - `jwt: false` → disabled
   * - `jwt: { enabled: false }` → disabled
   * - `undefined`, `true`, `{}`, or `{ expiresIn: '...' }` → enabled
   */
  isJwtEnabled(): boolean {
    if (!this.isEnabled()) return false;
    // JWT is enabled by default unless explicitly disabled
    const jwtConfig = this.config.jwt;
    if (jwtConfig === false) return false;
    if (typeof jwtConfig === 'object' && jwtConfig?.enabled === false) return false;
    return true;
  }

  /**
   * Checks if 2FA is enabled.
   * Supports both boolean and object configuration:
   * - `true` or `{}` → enabled
   * - `false` or `{ enabled: false }` → disabled
   */
  isTwoFactorEnabled(): boolean {
    return this.isEnabled() && this.isPluginEnabled(this.config.twoFactor);
  }

  /**
   * Checks if Passkey/WebAuthn is enabled.
   * Supports both boolean and object configuration:
   * - `true` or `{}` → enabled
   * - `false` or `{ enabled: false }` → disabled
   */
  isPasskeyEnabled(): boolean {
    return this.isEnabled() && this.isPluginEnabled(this.config.passkey);
  }

  /**
   * Helper to check if a plugin configuration is enabled.
   * Supports both boolean and object configuration.
   */
  private isPluginEnabled<T extends { enabled?: boolean }>(config: boolean | T | undefined): boolean {
    if (config === undefined) return false;
    if (typeof config === 'boolean') return config;
    return config.enabled !== false;
  }

  /**
   * Gets the list of enabled social providers
   * Dynamically iterates over all configured providers.
   *
   * A provider is considered enabled if:
   * - It has clientId and clientSecret configured
   * - It is NOT explicitly disabled (enabled !== false)
   *
   * This follows the same "enabled by default" pattern as Better-Auth itself.
   */
  getEnabledSocialProviders(): string[] {
    if (!this.isEnabled()) {
      return [];
    }

    const providers: string[] = [];

    // Dynamically iterate over all configured social providers
    if (this.config.socialProviders) {
      for (const [name, provider] of Object.entries(this.config.socialProviders)) {
        // Provider is enabled if: has credentials AND not explicitly disabled
        if (provider?.clientId && provider?.clientSecret && provider?.enabled !== false) {
          providers.push(name);
        }
      }
    }

    return providers;
  }

  /**
   * Gets the base path for better-auth endpoints
   */
  getBasePath(): string {
    return this.config.basePath || '/iam';
  }

  /**
   * Gets the base URL for better-auth
   */
  getBaseUrl(): string {
    return this.config.baseUrl || 'http://localhost:3000';
  }

  // ===================================================================================================================
  // JWT Token Methods
  // ===================================================================================================================

  /**
   * Gets a fresh JWT token for the current session.
   *
   * Use this when your JWT has expired but your session is still valid.
   * The JWT can be used for stateless authentication with other services
   * that verify tokens via JWKS (`/iam/jwks`).
   *
   * @param req - Express request object with session cookie/header
   * @returns Fresh JWT token or null if no valid session or JWT is disabled
   *
   * @example
   * ```typescript
   * const token = await betterAuthService.getToken(req);
   * if (token) {
   *   // Use token for microservice calls
   *   await fetch('https://api.example.com/data', {
   *     headers: { Authorization: `Bearer ${token}` }
   *   });
   * }
   * ```
   */
  async getToken(req: Request | { headers: Record<string, string | string[] | undefined> }): Promise<null | string> {
    if (!this.isEnabled() || !this.isJwtEnabled()) {
      return null;
    }

    const api = this.getApi();
    if (!api) {
      return null;
    }

    try {
      // Convert headers to the format Better-Auth expects
      const headers = new Headers();
      const reqHeaders = 'headers' in req ? req.headers : {};

      for (const [key, value] of Object.entries(reqHeaders)) {
        if (typeof value === 'string') {
          headers.set(key, value);
        } else if (Array.isArray(value)) {
          headers.set(key, value.join(', '));
        }
      }

      // Call the token endpoint via Better-Auth API
      // The jwt plugin adds a getToken method to the API
      const response = await (api as any).getToken({ headers });

      if (response && typeof response === 'object' && 'token' in response) {
        return response.token as string;
      }

      return null;
    } catch (error) {
      this.logger.debug(`getToken error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  // ===================================================================================================================
  // Session Management Methods
  // ===================================================================================================================

  /**
   * Gets the current session from request headers
   *
   * @param req - Express request object or headers object
   * @returns Session and user data, or null values if no valid session
   *
   * @example
   * ```typescript
   * const { session, user } = await betterAuthService.getSession(req);
   * if (session) {
   *   console.log('User:', user.email);
   *   console.log('Session expires:', session.expiresAt);
   * }
   * ```
   */
  async getSession(req: Request | { headers: Record<string, string | string[] | undefined> }): Promise<SessionResult> {
    if (!this.isEnabled()) {
      return { session: null, user: null };
    }

    const api = this.getApi();
    if (!api) {
      return { session: null, user: null };
    }

    try {
      // Convert headers to the format Better-Auth expects
      const headers = new Headers();
      const reqHeaders = 'headers' in req ? req.headers : {};

      for (const [key, value] of Object.entries(reqHeaders)) {
        if (typeof value === 'string') {
          headers.set(key, value);
        } else if (Array.isArray(value)) {
          headers.set(key, value.join(', '));
        }
      }

      // Debug: Log the cookie header being sent to api.getSession (masked for security)
      if (!this.isProd) {
        const cookieHeader = headers.get('cookie');
        this.logger.debug(`getSession called with cookies: ${maskCookieHeader(cookieHeader)}`);
      }

      const response = await api.getSession({ headers });

      // Debug: Log the response from api.getSession
      if (!this.isProd) {
        this.logger.debug(`getSession response: ${JSON.stringify(response)?.substring(0, 200)}`);
      }

      if (response && typeof response === 'object' && 'user' in response) {
        return response as SessionResult;
      }

      return { session: null, user: null };
    } catch (error) {
      if (!this.isProd) {
        this.logger.debug(`getSession error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return { session: null, user: null };
    }
  }

  /**
   * Revokes a specific session (logout for that session)
   *
   * This should be called when a user wants to log out from a specific device/session.
   * The session token is typically stored in a cookie or sent as a bearer token.
   *
   * @param sessionToken - The session token to revoke
   * @returns true if session was revoked, false otherwise
   *
   * @example
   * ```typescript
   * // Get session token from cookie or header
   * const sessionToken = req.cookies['better-auth.session_token'];
   * const success = await betterAuthService.revokeSession(sessionToken);
   * if (success) {
   *   res.clearCookie('better-auth.session_token');
   * }
   * ```
   */
  async revokeSession(sessionToken: string): Promise<boolean> {
    if (!this.isEnabled() || !sessionToken) {
      return false;
    }

    const api = this.getApi();
    if (!api) {
      return false;
    }

    try {
      // Create headers with the session token
      const headers = new Headers();
      headers.set('Authorization', `Bearer ${sessionToken}`);

      // Call Better-Auth's signOut endpoint
      await api.signOut({ headers });
      return true;
    } catch (error) {
      if (!this.isProd) {
        this.logger.debug(`revokeSession error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return false;
    }
  }

  /**
   * Checks if a session is close to expiring
   *
   * @param session - The session object from getSession()
   * @param thresholdMinutes - Minutes before expiry to consider "close to expiring" (default: 5)
   * @returns true if session expires within the threshold
   *
   * @example
   * ```typescript
   * const { session } = await betterAuthService.getSession(req);
   * if (session && betterAuthService.isSessionExpiringSoon(session)) {
   *   // Prompt user to refresh their session
   * }
   * ```
   */
  isSessionExpiringSoon(session: SessionResult['session'], thresholdMinutes: number = 5): boolean {
    if (!session?.expiresAt) {
      return true; // No session or no expiry = treat as expiring
    }

    const expiresAt = new Date(session.expiresAt);
    const now = new Date();
    const thresholdMs = thresholdMinutes * 60 * 1000;

    return expiresAt.getTime() - now.getTime() < thresholdMs;
  }

  /**
   * Gets the remaining session time in seconds
   *
   * @param session - The session object from getSession()
   * @returns Seconds until session expires, or 0 if expired/invalid
   */
  getSessionTimeRemaining(session: SessionResult['session']): number {
    if (!session?.expiresAt) {
      return 0;
    }

    const expiresAt = new Date(session.expiresAt);
    const now = new Date();
    const remaining = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));

    return remaining;
  }

  /**
   * Gets a session by token directly from the database.
   *
   * This method looks up the session in Better-Auth's session collection
   * and returns the associated user. Useful for verifying session tokens
   * passed via Authorization header.
   *
   * @param token - The session token to look up
   * @returns Session and user data, or null if not found/expired
   */
  async getSessionByToken(token: string): Promise<SessionResult> {
    if (!this.isEnabled() || !this.connection?.db) {
      return { session: null, user: null };
    }

    try {
      const db = this.connection.db;
      const sessionsCollection = db.collection('session');

      // Use aggregation pipeline for single-query lookup with automatic userId type handling
      // This handles both ObjectId and string userId formats efficiently
      const results = await sessionsCollection
        .aggregate([
          // Match session by token
          { $match: { token } },
          // Join with users collection - handles both ObjectId and string userId
          {
            $lookup: {
              as: 'userDoc',
              from: 'users',
              let: { sessionUserId: '$userId' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $or: [
                        // Match by _id (ObjectId comparison)
                        { $eq: ['$_id', '$$sessionUserId'] },
                        // Match by _id with string conversion
                        { $eq: [{ $toString: '$_id' }, { $toString: '$$sessionUserId' }] },
                        // Match by id field (string field)
                        { $eq: ['$id', { $toString: '$$sessionUserId' }] },
                      ],
                    },
                  },
                },
              ],
            },
          },
          // Unwind user document (results in null if no match)
          { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
          // Project final result
          { $limit: 1 },
        ])
        .toArray();

      const result = results[0];

      if (!result) {
        if (!this.isProd) {
          this.logger.debug(`getSessionByToken: session not found for token ${maskToken(token)}`);
        }
        return { session: null, user: null };
      }

      // Check if session is expired
      if (result.expiresAt && new Date(result.expiresAt) < new Date()) {
        if (!this.isProd) {
          this.logger.debug(`getSessionByToken: session expired`);
        }
        return { session: null, user: null };
      }

      const user = result.userDoc;
      if (!user) {
        if (!this.isProd) {
          this.logger.debug(`getSessionByToken: user not found for session`);
        }
        return { session: null, user: null };
      }

      if (!this.isProd) {
        this.logger.debug(`getSessionByToken: found session for user ${maskEmail(user.email)}`);
      }

      return {
        session: {
          expiresAt: result.expiresAt,
          id: result.id || result._id?.toString(),
          token: result.token,
          userId: result.userId?.toString(),
        },
        user: {
          email: user.email,
          emailVerified: user.emailVerified,
          id: user.id || user._id?.toString(),
          name: user.name,
        },
      };
    } catch (error) {
      if (!this.isProd) {
        this.logger.debug(`getSessionByToken error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return { session: null, user: null };
    }
  }

  // ===================================================================================================================
  // JWT Token Verification (for BetterAuth JWT tokens using JWKS)
  // ===================================================================================================================

  /**
   * Verifies a BetterAuth JWT token using JWKS public keys from the database.
   *
   * BetterAuth JWT tokens are signed with asymmetric keys (EdDSA/RSA/EC) stored in the
   * `jwks` collection. This method verifies the token signature using the public key
   * and returns the payload if valid.
   *
   * This enables stateless JWT verification without requiring a session cookie.
   *
   * @param token - The JWT token to verify (from Authorization header)
   * @returns The JWT payload with user info, or null if verification fails
   *
   * @example
   * ```typescript
   * const token = req.headers.authorization?.replace('Bearer ', '');
   * if (token) {
   *   const payload = await betterAuthService.verifyJwtToken(token);
   *   if (payload) {
   *     console.log('User ID:', payload.sub);
   *   }
   * }
   * ```
   */
  async verifyJwtToken(token: string): Promise<null | {
    [key: string]: any;
    email?: string;
    sub: string;
  }> {
    if (!this.isEnabled() || !this.isJwtEnabled()) {
      return null;
    }

    try {
      // Parse JWT header to determine algorithm
      const parts = token.split('.');
      if (parts.length !== 3) {
        this.logger.debug('Invalid JWT format');
        return null;
      }

      // Decode header (base64url)
      const headerStr = Buffer.from(parts[0], 'base64url').toString('utf-8');
      const header = JSON.parse(headerStr);
      const alg = header.alg;
      const kid = header.kid;

      // For HS256 (symmetric), verify with the BetterAuth secret
      if (alg === 'HS256') {
        return this.verifyHs256Token(token);
      }

      // For asymmetric algorithms (EdDSA, RS256, ES256), use JWKS
      if (kid && this.connection) {
        return this.verifyJwksToken(token, kid, alg);
      }

      this.logger.debug(`JWT verification: unsupported algorithm=${alg} or missing kid`);
      return null;
    } catch (error) {
      this.logger.debug(`JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Verifies an HS256 JWT token using the BetterAuth secret
   */
  private async verifyHs256Token(token: string): Promise<null | {
    [key: string]: any;
    email?: string;
    sub: string;
  }> {
    try {
      const secret = this.config.secret;

      if (!secret) {
        this.logger.debug('HS256 verification failed: no secret configured');
        return null;
      }

      // Create secret key from the BetterAuth secret
      const secretKey = new TextEncoder().encode(secret);

      // Verify the token
      const { payload } = await jwtVerify(token, secretKey);

      if (!payload.sub) {
        this.logger.debug('JWT payload missing sub claim');
        return null;
      }

      return payload as { [key: string]: any; email?: string; sub: string };
    } catch (error) {
      this.logger.debug(`HS256 verification error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Verifies a JWT token using JWKS public keys from the database
   */
  private async verifyJwksToken(
    token: string,
    kid: string,
    alg: string,
  ): Promise<null | {
    [key: string]: any;
    email?: string;
    sub: string;
  }> {
    if (!this.connection) {
      this.logger.debug('JWKS verification failed: no database connection');
      return null;
    }

    try {
      // Fetch the JWKS public key from database
      const jwksCollection = this.connection.collection('jwks');
      let keyRecord = await jwksCollection.findOne({ id: kid });

      if (!keyRecord) {
        // Try with _id as fallback (MongoDB ObjectId)
        const allKeys = await jwksCollection.find({}).toArray();
        const matchingKey = allKeys.find((k) => k.id === kid || k._id?.toString() === kid);
        if (!matchingKey) {
          this.logger.debug(`No JWKS key found for kid: ${kid}`);
          return null;
        }
        keyRecord = matchingKey;
      }

      if (!keyRecord?.publicKey) {
        this.logger.debug('JWKS key has no public key');
        return null;
      }

      // Parse the public key and import it
      const publicKey = JSON.parse(keyRecord.publicKey);
      const algorithm = alg || keyRecord.alg || 'EdDSA';
      const key = await importJWK(publicKey, algorithm);

      // Verify the JWT - issuer and audience default to baseUrl in Better-Auth
      const baseUrl = this.getBaseUrl();
      const { payload } = await jwtVerify(token, key, {
        audience: baseUrl,
        issuer: baseUrl,
      });

      if (!payload.sub) {
        this.logger.debug('JWT payload missing sub claim');
        return null;
      }

      return payload as { [key: string]: any; email?: string; sub: string };
    } catch (error) {
      this.logger.debug(`JWKS verification error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Extracts and verifies a JWT token from a request's Authorization header.
   *
   * @param req - Express request object
   * @returns The JWT payload with user info, or null if no valid token
   */
  async verifyJwtFromRequest(req: Request): Promise<null | {
    [key: string]: any;
    email?: string;
    sub: string;
  }> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.substring(7);
    return this.verifyJwtToken(token);
  }
}
