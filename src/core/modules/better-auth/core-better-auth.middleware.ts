import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { maskEmail, maskToken } from '../../common/helpers/logging.helper';
import { BetterAuthSessionUser, CoreBetterAuthUserMapper, MappedUser } from './core-better-auth-user.mapper';
import { extractSessionToken } from './core-better-auth-web.helper';
import { CoreBetterAuthService } from './core-better-auth.service';

/**
 * Extended Express Request with Better-Auth session data
 */
export interface CoreBetterAuthRequest extends Request {
  betterAuthSession?: {
    session: any;
    user: BetterAuthSessionUser;
  };
  betterAuthUser?: BetterAuthSessionUser;
  user?: MappedUser | Request['user'];
}

/**
 * Middleware that processes Better-Auth sessions and maps users
 *
 * This middleware:
 * 1. Checks if Better-Auth is enabled
 * 2. Validates the session using Better-Auth's API
 * 3. Maps the Better-Auth user to our User model with hasRole() capability
 * 4. Attaches the mapped user to req.user for use with our security decorators
 *
 * IMPORTANT: This middleware runs BEFORE guards, so the user will be available
 * for RolesGuard and other security checks.
 */
@Injectable()
export class CoreBetterAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CoreBetterAuthMiddleware.name);

  constructor(
    private readonly betterAuthService: CoreBetterAuthService,
    private readonly userMapper: CoreBetterAuthUserMapper,
  ) {}

  async use(req: CoreBetterAuthRequest, _res: Response, next: NextFunction) {
    // Skip if Better-Auth is not enabled
    if (!this.betterAuthService.isEnabled()) {
      return next();
    }

    // Skip if user is already set (e.g., by JWT auth)
    if (req.user) {
      return next();
    }

    try {
      // Strategy 1: Try session-based authentication (cookies)
      const session = await this.getSession(req);

      if (session?.user) {
        // Store the original Better-Auth session
        req.betterAuthSession = session;
        req.betterAuthUser = session.user;

        // Map the Better-Auth user to our User model with hasRole()
        const mappedUser = await this.userMapper.mapSessionUser(session.user);

        if (mappedUser) {
          // Attach the mapped user to the request
          // This makes it compatible with @CurrentUser() and RolesGuard
          // Set _authenticatedViaBetterAuth flag so AuthGuard skips Passport JWT verification
          req.user = { ...mappedUser, _authenticatedViaBetterAuth: true };
          return next();
        }
      }

      // Strategy 2: Try Authorization header (Bearer token)
      // The token could be a BetterAuth JWT, a Legacy JWT, or a session token
      if (req.headers.authorization) {
        const authHeader = req.headers.authorization;
        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
        const tokenParts = token.split('.').length;

        // Check if token looks like a JWT (has 3 parts)
        if (tokenParts === 3) {
          // Decode JWT payload to check if it's a Legacy JWT or BetterAuth JWT
          // Legacy JWTs have 'id' claim, BetterAuth JWTs use 'sub'
          const isLegacyJwt = this.isLegacyJwt(token);
          if (isLegacyJwt) {
            // Legacy JWT - skip BetterAuth processing, let Passport handle it
            return next();
          }

          // Try BetterAuth JWT verification
          if (this.betterAuthService.isJwtEnabled()) {
            const jwtPayload = await this.betterAuthService.verifyJwtFromRequest(req);

            if (jwtPayload?.sub) {
              // JWT payload contains user info - create a session-like user object
              const sessionUser: BetterAuthSessionUser = {
                email: jwtPayload.email || '',
                emailVerified: jwtPayload.emailVerified,
                id: jwtPayload.sub,
                name: jwtPayload.name,
              };

              req.betterAuthUser = sessionUser;

              // Map the JWT user to our User model with hasRole()
              const mappedUser = await this.userMapper.mapSessionUser(sessionUser);

              if (mappedUser) {
                req.user = { ...mappedUser, _authenticatedViaBetterAuth: true };
                return next();
              }
            }
          }
        }

        // If user is still not set, try session token verification as fallback
        // This handles both non-JWT tokens and JWTs that couldn't be verified
        if (!req.user) {
          const sessionResult = await this.betterAuthService.getSessionByToken(token);
          if (sessionResult?.user) {
            req.betterAuthSession = { session: sessionResult.session, user: sessionResult.user };
            req.betterAuthUser = sessionResult.user;

            const mappedUser = await this.userMapper.mapSessionUser(sessionResult.user);
            if (mappedUser) {
              req.user = { ...mappedUser, _authenticatedViaBetterAuth: true };
              return next();
            }
          }
        }
      }
    } catch (error) {
      // Don't block the request on auth errors
      // The guards will handle unauthorized access
      this.logger.debug(`Session validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    next();
  }

  /**
   * Checks if a JWT token is a Legacy Auth JWT (has 'id' claim but no 'sub' claim)
   * Legacy JWTs use 'id' for user ID, BetterAuth JWTs use 'sub'
   */
  private isLegacyJwt(token: string): boolean {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return false;

      // Decode the payload (second part)
      const payloadStr = Buffer.from(parts[1], 'base64url').toString('utf-8');
      const payload = JSON.parse(payloadStr);

      // Legacy JWT has 'id' claim (and typically 'deviceId', 'tokenId')
      // BetterAuth JWT has 'sub' claim
      return payload.id !== undefined && payload.sub === undefined;
    } catch {
      return false;
    }
  }

  /**
   * Gets the session from Better-Auth using session token from cookies
   *
   * This method first tries to extract the session token from cookies
   * (checking multiple cookie names for compatibility), then validates
   * the session directly from the database using getSessionByToken().
   */
  private async getSession(req: Request): Promise<null | { session: any; user: BetterAuthSessionUser }> {
    try {
      // Strategy 1: Try to get session token from cookies using shared helper
      const basePath = this.betterAuthService.getBasePath();
      const sessionToken = extractSessionToken(req, basePath);

      this.logger.debug(`[MIDDLEWARE] getSession called, token found: ${sessionToken ? 'yes' : 'no'}`);

      if (sessionToken) {
        this.logger.debug(`[MIDDLEWARE] Found session token in cookies: ${maskToken(sessionToken)}`);

        // Use getSessionByToken to validate session directly from database
        const sessionResult = await this.betterAuthService.getSessionByToken(sessionToken);

        this.logger.debug(
          `[MIDDLEWARE] getSessionByToken result: user=${maskEmail(sessionResult?.user?.email)}, session=${!!sessionResult?.session}`,
        );

        if (sessionResult?.user && sessionResult?.session) {
          this.logger.debug(`[MIDDLEWARE] Session validated for user: ${maskEmail(sessionResult.user.email)}`);
          return sessionResult as { session: any; user: BetterAuthSessionUser };
        }
      }

      // Strategy 2: Fallback to api.getSession() for edge cases
      const api = this.betterAuthService.getApi();
      if (!api) {
        return null;
      }

      // Convert Express headers to the format Better-Auth expects
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') {
          headers.set(key, value);
        } else if (Array.isArray(value)) {
          headers.set(key, value.join(', '));
        }
      }

      // Call Better-Auth's getSession API
      const response = await api.getSession({ headers });

      if (response && typeof response === 'object' && 'user' in response) {
        return response as { session: any; user: BetterAuthSessionUser };
      }

      return null;
    } catch (error) {
      this.logger.debug(`getSession error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }
}
