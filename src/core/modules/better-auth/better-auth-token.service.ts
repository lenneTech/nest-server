import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';

import { BetterAuthenticatedUser } from './better-auth.types';
import { CoreBetterAuthService } from './core-better-auth.service';

/**
 * Result of token extraction from a request
 */
export interface TokenExtractionResult {
  /** Source of the token (header or cookie) */
  source: 'cookie' | 'header' | null;
  /** The extracted token, if found */
  token: null | string;
}

/**
 * BetterAuthTokenService provides centralized token extraction and user loading
 * for BetterAuth authentication.
 *
 * This service consolidates the token verification logic that was previously
 * duplicated in AuthGuard and RolesGuard, providing:
 * - Token extraction from Authorization header or cookies
 * - JWT token verification via BetterAuth
 * - Session token verification via database lookup
 * - User loading from MongoDB with hasRole() capability
 *
 * @example
 * ```typescript
 * const token = this.tokenService.extractTokenFromRequest(request);
 * if (token) {
 *   const user = await this.tokenService.verifyAndLoadUser(token);
 *   if (user) {
 *     request.user = user;
 *   }
 * }
 * ```
 */
@Injectable()
export class BetterAuthTokenService {
  private readonly logger = new Logger(BetterAuthTokenService.name);

  constructor(
    @Optional() private readonly betterAuthService?: CoreBetterAuthService,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  /**
   * Extracts a token from the request's Authorization header or cookies.
   *
   * Checks in order:
   * 1. Authorization header (Bearer token)
   * 2. Session cookies (iam.session_token, better-auth.session_token, token)
   *
   * @param request - HTTP request object with headers and cookies
   * @returns Token extraction result with token and source
   */
  extractTokenFromRequest(request: {
    cookies?: Record<string, string>;
    headers?: Record<string, string | string[] | undefined>;
  }): TokenExtractionResult {
    // Try Authorization header first
    const authHeader = request.headers?.authorization || request.headers?.Authorization;
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (headerValue) {
      if (headerValue.startsWith('Bearer ') || headerValue.startsWith('bearer ')) {
        return { source: 'header', token: headerValue.substring(7) };
      }
    }

    // Try cookies
    if (request.cookies && this.betterAuthService) {
      const cookieName = this.betterAuthService.getSessionCookieName();
      const token =
        request.cookies[cookieName] ||
        request.cookies['better-auth.session_token'] ||
        request.cookies['token'] ||
        undefined;

      if (token) {
        return { source: 'cookie', token };
      }
    }

    return { source: null, token: null };
  }

  /**
   * Verifies a token (JWT or session) and loads the corresponding user from MongoDB.
   *
   * This method tries multiple verification strategies:
   * 1. BetterAuth JWT verification (if JWT plugin is enabled)
   * 2. BetterAuth session token lookup (database lookup)
   *
   * @param token - The token to verify
   * @returns User object with hasRole method, or null if verification fails
   */
  async verifyAndLoadUser(token: string): Promise<BetterAuthenticatedUser | null> {
    if (!this.betterAuthService || !this.connection) {
      return null;
    }

    // Strategy 1: Try JWT verification (if JWT plugin is enabled)
    if (this.betterAuthService.isJwtEnabled()) {
      try {
        const payload = await this.betterAuthService.verifyJwtToken(token);
        if (payload?.sub) {
          const user = await this.loadUserFromPayload(payload);
          if (user) {
            return user;
          }
        }
      } catch (error) {
        // Check for token expiration
        if (error instanceof Error && error.message.includes('expired')) {
          this.logger.debug('JWT token expired');
          throw error; // Re-throw for proper handling by guards
        }
        // Other JWT verification failures - try session token next
        this.logger.debug(
          `JWT verification failed, trying session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    // Strategy 2: Try session token lookup (database lookup)
    try {
      const sessionResult = await this.betterAuthService.getSessionByToken(token);
      if (sessionResult?.user) {
        return this.loadUserFromSessionResult(sessionResult.user);
      }
    } catch (error) {
      this.logger.debug(`Session lookup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return null;
  }

  /**
   * Creates a user object with hasRole method from a MongoDB document.
   *
   * @param user - Raw MongoDB user document
   * @returns User object with hasRole method
   */
  createUserWithHasRole(user: Record<string, unknown>): BetterAuthenticatedUser {
    return {
      ...user,
      _authenticatedViaBetterAuth: true,
      hasRole: (roles: string[]): boolean => {
        const userRoles = user.roles;
        if (!userRoles || !Array.isArray(userRoles)) {
          return false;
        }
        return roles.some((role) => userRoles.includes(role));
      },
      id: (user._id as Types.ObjectId)?.toString() || (user.id as string),
    } as BetterAuthenticatedUser;
  }

  /**
   * Loads a user from JWT payload using direct MongoDB query.
   *
   * @param payload - JWT payload with sub (user ID or iamId)
   * @returns User object with hasRole method, or null if not found
   */
  private async loadUserFromPayload(payload: { [key: string]: unknown; sub: string }): Promise<BetterAuthenticatedUser | null> {
    if (!this.connection) {
      return null;
    }

    try {
      const usersCollection = this.connection.collection('users');
      let user: null | Record<string, unknown> = null;

      // Try to find by MongoDB _id first
      if (Types.ObjectId.isValid(payload.sub)) {
        user = await usersCollection.findOne({ _id: new Types.ObjectId(payload.sub) });
      }

      // If not found, try by iamId
      if (!user) {
        user = await usersCollection.findOne({ iamId: payload.sub });
      }

      if (!user) {
        return null;
      }

      return this.createUserWithHasRole(user);
    } catch (error) {
      this.logger.debug(`Failed to load user from payload: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Loads a user from session result (from getSessionByToken).
   *
   * @param sessionUser - User object from session lookup
   * @returns User object with hasRole method, or null if not found
   */
  private async loadUserFromSessionResult(sessionUser: {
    email?: string;
    id?: string;
  }): Promise<BetterAuthenticatedUser | null> {
    if (!this.connection || !sessionUser) {
      return null;
    }

    try {
      const usersCollection = this.connection.collection('users');
      let user: null | Record<string, unknown> = null;

      // Try to find by email (most reliable)
      if (sessionUser.email) {
        user = await usersCollection.findOne({ email: sessionUser.email });
      }

      // If not found by email, try by iamId
      if (!user && sessionUser.id) {
        user = await usersCollection.findOne({ iamId: sessionUser.id });
      }

      // If still not found, try by _id (if the ID looks like a MongoDB ObjectId)
      if (!user && sessionUser.id && Types.ObjectId.isValid(sessionUser.id)) {
        user = await usersCollection.findOne({ _id: new Types.ObjectId(sessionUser.id) });
      }

      if (!user) {
        return null;
      }

      return this.createUserWithHasRole(user);
    } catch (error) {
      this.logger.debug(`Failed to load user from session: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }
}
