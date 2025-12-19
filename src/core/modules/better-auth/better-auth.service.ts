import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Request } from 'express';

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
@Injectable()
export class BetterAuthService {
  private readonly logger = new Logger(BetterAuthService.name);
  private readonly config: IBetterAuth;

  constructor(
    @Optional() @Inject(BETTER_AUTH_INSTANCE) private readonly authInstance: BetterAuthInstance | null,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.config = this.configService?.get<IBetterAuth>('betterAuth') || { enabled: false };
  }

  /**
   * Checks if better-auth is enabled and initialized
   */
  isEnabled(): boolean {
    return this.config?.enabled === true && this.authInstance !== null;
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
   * Checks if JWT plugin is enabled
   */
  isJwtEnabled(): boolean {
    return this.isEnabled() && this.config.jwt?.enabled === true;
  }

  /**
   * Checks if 2FA is enabled
   */
  isTwoFactorEnabled(): boolean {
    return this.isEnabled() && this.config.twoFactor?.enabled === true;
  }

  /**
   * Checks if Passkey/WebAuthn is enabled
   */
  isPasskeyEnabled(): boolean {
    return this.isEnabled() && this.config.passkey?.enabled === true;
  }

  /**
   * Checks if legacy password handling is enabled
   */
  isLegacyPasswordEnabled(): boolean {
    return this.isEnabled() && this.config.legacyPassword?.enabled === true;
  }

  /**
   * Gets the list of enabled social providers
   */
  getEnabledSocialProviders(): string[] {
    if (!this.isEnabled()) {
      return [];
    }

    const providers: string[] = [];
    if (this.config.socialProviders?.google?.enabled) {
      providers.push('google');
    }
    if (this.config.socialProviders?.github?.enabled) {
      providers.push('github');
    }
    if (this.config.socialProviders?.apple?.enabled) {
      providers.push('apple');
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

      const response = await api.getSession({ headers });

      if (response && typeof response === 'object' && 'user' in response) {
        return response as SessionResult;
      }

      return { session: null, user: null };
    } catch (error) {
      this.logger.debug(`getSession error: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

      this.logger.debug('Session revoked successfully');
      return true;
    } catch (error) {
      this.logger.debug(`revokeSession error: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
}
