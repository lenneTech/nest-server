import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { isLegacyJwt } from './core-better-auth-token.helper';
import { BetterAuthSessionUser, CoreBetterAuthUserMapper, MappedUser } from './core-better-auth-user.mapper';
import { convertExpressHeaders, extractSessionToken } from './core-better-auth-web.helper';
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
 * Token priority: Authorization header > Cookies
 * The Authorization header is explicitly set by the client and takes precedence
 * over cookies which are implicitly sent by the browser.
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
      // Strategy 1: Try Authorization header (Bearer token) - takes precedence
      // The Authorization header is explicitly set by the client, so it should
      // override cookies which are implicitly sent by the browser.
      if (req.headers.authorization) {
        const authHeader = req.headers.authorization;
        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
        const tokenParts = token.split('.').length;

        // Check if token looks like a JWT (has 3 parts)
        if (tokenParts === 3) {
          // Check if it's a Legacy JWT (has 'id' claim, no 'sub')
          // Legacy JWTs should be handled by Passport, not Better-Auth
          if (isLegacyJwt(token)) {
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

              // Also resolve the real session from DB so that BetterAuth's plugin endpoints
              // (2FA, Passkey, etc.) can authenticate via session token.
              // Without this, JWT-only clients cannot use plugin routes.
              try {
                const sessionResult = await this.betterAuthService.getActiveSessionForUser(jwtPayload.sub);
                if (sessionResult?.session && sessionResult?.user) {
                  req.betterAuthSession = { session: sessionResult.session, user: sessionResult.user };
                }
              } catch {
                // Session resolution is optional - JWT auth still works for NestJS routes
              }

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

      // Strategy 2: Try JWT from cookie (for JWT mode when frontend stores JWT as cookie)
      // In JWT mode (cookies=false), the frontend may store the JWT in a cookie
      // (e.g., lt-jwt-token) instead of sending it as an Authorization header.
      // This bridges the gap between cookie-based frontend storage and JWT verification.
      if (!req.user && !req.headers.authorization && this.betterAuthService.isJwtEnabled()) {
        // Try parsed cookies first, then raw header (cookie-parser may not have run yet)
        let jwtFromCookie = req.cookies?.['lt-jwt-token'];
        if (!jwtFromCookie && req.headers.cookie) {
          const match = req.headers.cookie.match(/(?:^|;\s*)lt-jwt-token=([^;]+)/);
          if (match) {
            jwtFromCookie = decodeURIComponent(match[1]);
          }
        }
        if (jwtFromCookie && jwtFromCookie.split('.').length === 3 && !isLegacyJwt(jwtFromCookie)) {
          const jwtPayload = await this.betterAuthService.verifyJwtFromRequest(req, jwtFromCookie);

          if (jwtPayload?.sub) {
            const sessionUser: BetterAuthSessionUser = {
              email: jwtPayload.email || '',
              emailVerified: jwtPayload.emailVerified,
              id: jwtPayload.sub,
              name: jwtPayload.name,
            };

            req.betterAuthUser = sessionUser;

            // Resolve real DB session for plugin endpoints (2FA, Passkey, etc.)
            try {
              const sessionResult = await this.betterAuthService.getActiveSessionForUser(jwtPayload.sub);
              if (sessionResult?.session && sessionResult?.user) {
                req.betterAuthSession = { session: sessionResult.session, user: sessionResult.user };
              }
            } catch {
              // Session resolution is optional
            }

            const mappedUser = await this.userMapper.mapSessionUser(sessionUser);
            if (mappedUser) {
              req.user = { ...mappedUser, _authenticatedViaBetterAuth: true };
              return next();
            }
          }
        }
      }

      // Strategy 3: Fallback to session-based authentication (cookies)
      // Only used when no Authorization header is present or header auth failed
      if (!req.user) {
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
      }
    } catch (error) {
      // Don't block the request on auth errors
      // The guards will handle unauthorized access
      this.logger.debug(`Session validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    next();
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

      if (sessionToken) {
        // Use getSessionByToken to validate session directly from database
        const sessionResult = await this.betterAuthService.getSessionByToken(sessionToken);

        if (sessionResult?.user && sessionResult?.session) {
          return sessionResult as { session: any; user: BetterAuthSessionUser };
        }
      }

      // Strategy 2: Fallback to api.getSession() for edge cases
      const api = this.betterAuthService.getApi();
      if (!api) {
        return null;
      }

      // Convert Express headers to the format Better-Auth expects
      const headers = convertExpressHeaders(req.headers as Record<string, string | string[] | undefined>);

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
