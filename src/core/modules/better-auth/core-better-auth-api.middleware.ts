import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { isProduction } from '../../common/helpers/logging.helper';
import { extractSessionToken, sendWebResponse, toWebRequest } from './core-better-auth-web.helper';
import { CoreBetterAuthService } from './core-better-auth.service';

/**
 * List of paths that are handled by CoreBetterAuthController
 * These should NOT be forwarded to Better Auth's native handler
 *
 * Only paths with nest-server-specific logic belong here:
 * - sign-in/email: Legacy user migration, password normalization
 * - sign-up/email: User linking to own DB, password sync
 * - sign-out: Custom cookie clearing
 * - session: Custom response format with mapped user
 *
 * All other paths (Passkey, 2FA, etc.) go directly to Better Auth's
 * native handler via this middleware for maximum compatibility.
 */
const CONTROLLER_HANDLED_PATHS = [
  '/sign-in/email',
  '/sign-up/email',
  '/sign-out',
  '/session',
];

/**
 * Middleware that forwards Better Auth API requests to the native Better Auth handler.
 *
 * This middleware handles ALL Better Auth plugin functionality directly:
 * - Passkey/WebAuthn (registration, authentication, management)
 * - Two-Factor Authentication (TOTP enable, disable, verify)
 * - Social Login OAuth flows
 * - Magic link authentication
 * - Email verification
 *
 * The middleware:
 * 1. Checks if the request path starts with the Better Auth base path (e.g., /iam)
 * 2. Skips paths that need nest-server-specific logic (sign-in, sign-up, session)
 * 3. Extracts session token and signs cookies for Better Auth compatibility
 * 4. Converts the Express request to a Web Standard Request
 * 5. Calls Better Auth's native handler and sends the response
 *
 * IMPORTANT: Cookie signing is handled here to ensure Better Auth receives
 * properly signed session cookies for all plugin endpoints.
 */
@Injectable()
export class CoreBetterAuthApiMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CoreBetterAuthApiMiddleware.name);
  private readonly isProd = isProduction();

  constructor(private readonly betterAuthService: CoreBetterAuthService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    // Skip if Better-Auth is not enabled
    if (!this.betterAuthService.isEnabled()) {
      return next();
    }

    const basePath = this.betterAuthService.getBasePath();
    const requestPath = req.path;

    // Only handle requests that start with the Better Auth base path
    if (!requestPath.startsWith(basePath)) {
      return next();
    }

    // Get the path relative to the base path
    const relativePath = requestPath.slice(basePath.length);

    // Skip paths that are handled by CoreBetterAuthController (nest-server-specific logic)
    if (CONTROLLER_HANDLED_PATHS.some((path) => relativePath === path || relativePath.startsWith(`${path}/`))) {
      return next();
    }

    // Get the Better Auth instance
    const authInstance = this.betterAuthService.getInstance();
    if (!authInstance) {
      this.logger.warn('Better Auth instance not available');
      return next();
    }

    if (!this.isProd) {
      this.logger.debug(`Forwarding to Better Auth handler: ${req.method} ${requestPath}`);
    }

    try {
      // Extract session token from cookies or Authorization header
      const sessionToken = extractSessionToken(req, basePath);

      // Get config for cookie signing
      const config = this.betterAuthService.getConfig();

      // Convert Express request to Web Standard Request with proper cookie signing
      // This ensures Better Auth receives signed cookies for session validation
      const webRequest = await toWebRequest(req, {
        basePath,
        baseUrl: this.betterAuthService.getBaseUrl(),
        logger: this.logger,
        secret: config.secret,
        sessionToken,
      });

      // Call Better Auth's native handler
      const response = await authInstance.handler(webRequest);

      if (!this.isProd) {
        this.logger.debug(`Better Auth handler response: ${response.status}`);
      }

      // Convert Web Standard Response to Express response using shared helper
      await sendWebResponse(res, response);
    } catch (error) {
      // Log error with appropriate detail level
      if (this.isProd) {
        this.logger.error('Better Auth handler error');
      } else {
        this.logger.error(`Better Auth handler error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Send error response if headers not sent
      if (!res.headersSent) {
        const message = this.isProd
          ? 'Authentication error'
          : (error instanceof Error ? error.message : 'Unknown error');
        res.status(500).json({
          error: 'Authentication handler error',
          message,
        });
      }
    }
  }
}
