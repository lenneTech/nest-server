import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { isProduction } from '../../common/helpers/logging.helper';
import { sendWebResponse, toWebRequest } from './better-auth-web.helper';
import { BetterAuthService } from './better-auth.service';

/**
 * List of paths that are handled by CoreBetterAuthController
 * These should NOT be forwarded to Better Auth's native handler
 *
 * NOTE: The following endpoints are handled by Better Auth's native plugins
 * for maximum compatibility, updateability, and reduced maintenance:
 *
 * Passkey (WebAuthn):
 *   /passkey/generate-register-options, /passkey/verify-registration,
 *   /passkey/generate-authenticate-options, /passkey/verify-authentication,
 *   /passkey/list-user-passkeys, /passkey/delete-passkey, /passkey/update-passkey
 *
 * Two-Factor Authentication (TOTP):
 *   /two-factor/enable, /two-factor/disable, /two-factor/verify-totp,
 *   /two-factor/generate-backup-codes, /two-factor/verify-backup-code
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
 * This middleware is CRITICAL for plugin functionality like Passkey/WebAuthn, social login,
 * magic link, email verification, etc. These endpoints are not explicitly defined in the
 * CoreBetterAuthController but are provided by Better Auth's plugin system.
 *
 * The middleware:
 * 1. Checks if the request path starts with the Better Auth base path (e.g., /iam)
 * 2. Skips paths that are handled by CoreBetterAuthController
 * 3. Converts the Express request to a Web Standard Request (required by Better Auth)
 * 4. Calls Better Auth's native handler and sends the response
 *
 * IMPORTANT: This middleware must be registered BEFORE body-parser middleware,
 * or the request body must be properly reconstructed for POST requests.
 */
@Injectable()
export class BetterAuthApiMiddleware implements NestMiddleware {
  private readonly logger = new Logger(BetterAuthApiMiddleware.name);
  private readonly isProd = isProduction();

  constructor(private readonly betterAuthService: BetterAuthService) {}

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

    // Skip paths that are handled by CoreBetterAuthController
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
      // Convert Express request to Web Standard Request using shared helper
      const webRequest = await toWebRequest(req, {
        baseUrl: this.betterAuthService.getBaseUrl(),
      });

      // Call Better Auth's native handler
      const response = await authInstance.handler(webRequest);

      // Convert Web Standard Response to Express response using shared helper
      await sendWebResponse(res, response);
    } catch (error) {
      // Log error with appropriate detail level
      // In production: log generic message to avoid exposing internals
      // In development: log full error for debugging
      if (this.isProd) {
        this.logger.error('Better Auth handler error');
      } else {
        this.logger.error(`Better Auth handler error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Send error response if headers not sent
      // In production, don't expose internal error details to clients
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
