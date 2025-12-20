import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { BetterAuthSessionUser, BetterAuthUserMapper, MappedUser } from './better-auth-user.mapper';
import { BetterAuthService } from './better-auth.service';

/**
 * Extended Express Request with Better-Auth session data
 */
export interface BetterAuthRequest extends Request {
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
export class BetterAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(BetterAuthMiddleware.name);

  constructor(
    private readonly betterAuthService: BetterAuthService,
    private readonly userMapper: BetterAuthUserMapper,
  ) {}

  async use(req: BetterAuthRequest, _res: Response, next: NextFunction) {
    // Skip if Better-Auth is not enabled
    if (!this.betterAuthService.isEnabled()) {
      return next();
    }

    // Skip if user is already set (e.g., by JWT auth)
    if (req.user) {
      return next();
    }

    try {
      // Get session from Better-Auth
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
          req.user = mappedUser;
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
   * Gets the session from Better-Auth
   */
  private async getSession(req: Request): Promise<null | { session: any; user: BetterAuthSessionUser }> {
    const api = this.betterAuthService.getApi();
    if (!api) {
      return null;
    }

    try {
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
