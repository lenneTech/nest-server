import { Injectable, Logger, NestMiddleware, Optional } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { isProduction } from '../../common/helpers/logging.helper';
import { CoreBetterAuthChallengeService } from './core-better-auth-challenge.service';
import { extractSessionToken, sendWebResponse, signCookieValue, toWebRequest } from './core-better-auth-web.helper';
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
const CONTROLLER_HANDLED_PATHS = ['/sign-in/email', '/sign-up/email', '/sign-out', '/session'];

/**
 * Passkey paths that generate challenges
 */
const PASSKEY_GENERATE_PATHS = ['/passkey/generate-register-options', '/passkey/generate-authenticate-options'];

/**
 * Passkey paths that verify challenges
 */
const PASSKEY_VERIFY_PATHS = ['/passkey/verify-registration', '/passkey/verify-authentication'];

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
 * For JWT mode (cookieless), this middleware provides an adapter for Passkey challenges:
 * 1. On generate: Extracts Better Auth's verificationToken from Set-Cookie and stores mapping
 * 2. On verify: Injects verificationToken as cookie so Better Auth can find the challenge
 *
 * This approach maintains full compatibility with Better Auth's internal mechanisms.
 */
@Injectable()
export class CoreBetterAuthApiMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CoreBetterAuthApiMiddleware.name);
  private readonly isProd = isProduction();
  private loggedChallengeStorageMode = false;

  constructor(
    private readonly betterAuthService: CoreBetterAuthService,
    @Optional() private readonly challengeService?: CoreBetterAuthChallengeService,
  ) {}

  /**
   * Check if database challenge storage should be used.
   * This is checked dynamically because the ChallengeService initializes in onModuleInit.
   */
  private useDbChallengeStorage(): boolean {
    const enabled = this.challengeService?.isEnabled() ?? false;
    if (enabled && !this.loggedChallengeStorageMode) {
      this.logger.log('Passkey challenge storage: database (JWT mode compatible)');
      this.loggedChallengeStorageMode = true;
    }
    return enabled;
  }

  async use(req: Request, res: Response, next: NextFunction) {
    // Skip if Better-Auth is not enabled
    if (!this.betterAuthService.isEnabled()) {
      return next();
    }

    const basePath = this.betterAuthService.getBasePath();
    // Use originalUrl to get full path for IAM endpoints, but fallback to req.path
    // The originalUrl contains the original request path as sent by client
    const requestPath = req.originalUrl?.split('?')[0] || req.path;

    // Only handle requests that start with the Better Auth base path
    if (!requestPath.startsWith(basePath)) {
      return next();
    }

    this.logger.debug(`API Middleware handling: ${req.method} ${requestPath}`);

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

    this.logger.debug(`Forwarding to Better Auth handler: ${req.method} ${requestPath}`);

    try {
      // Check if this is a passkey request that needs DB challenge handling
      const useDbStorage = this.useDbChallengeStorage();
      const isPasskeyGenerate = useDbStorage && PASSKEY_GENERATE_PATHS.some((p) => relativePath === p);
      const isPasskeyVerify = useDbStorage && PASSKEY_VERIFY_PATHS.some((p) => relativePath === p);

      // Extract session token from cookies or Authorization header
      const sessionToken = extractSessionToken(req, basePath);

      // Get config for cookie signing
      const config = this.betterAuthService.getConfig();
      const cookieName = this.challengeService?.getCookieName() || 'better-auth.better-auth-passkey';

      // For passkey verify requests with DB storage, inject the verificationToken as a cookie
      let challengeIdToDelete: string | undefined;
      if (isPasskeyVerify && this.challengeService) {
        const challengeId = req.body?.challengeId;
        this.logger.debug(
          `Passkey verify: challengeId=${challengeId ? `${challengeId.substring(0, 8)}...` : 'MISSING'}, body keys=${Object.keys(req.body || {}).join(', ')}`,
        );
        if (challengeId) {
          const verificationToken = await this.challengeService.getVerificationToken(challengeId);
          if (verificationToken) {
            // Sign the verificationToken and inject it as a cookie
            const signedToken = signCookieValue(verificationToken, config.secret || '');

            // Add the challenge cookie to the request headers
            const existingCookies = req.headers.cookie || '';
            req.headers.cookie = existingCookies
              ? `${existingCookies}; ${cookieName}=${signedToken}`
              : `${cookieName}=${signedToken}`;

            challengeIdToDelete = challengeId;

            this.logger.debug(`Injected verificationToken for passkey verification`);
          } else {
            // Challenge mapping not found - let Better Auth handle the error
            this.logger.debug(`Challenge mapping not found: ${challengeId.substring(0, 8)}...`);
          }
        }
      }

      // Convert Express request to Web Standard Request with proper cookie signing
      const webRequest = await toWebRequest(req, {
        basePath,
        baseUrl: this.betterAuthService.getBaseUrl(),
        logger: this.logger,
        secret: config.secret,
        sessionToken,
      });

      // Call Better Auth's native handler
      const response = await authInstance.handler(webRequest);

      this.logger.debug(`Better Auth handler response: ${response.status}`);

      // For passkey generate requests with DB storage, extract verificationToken and store mapping
      if (isPasskeyGenerate && response.ok && this.challengeService) {
        // Extract verificationToken from Set-Cookie header
        const setCookieHeaders = response.headers.getSetCookie?.() || [];
        let verificationToken: null | string = null;

        for (const cookieHeader of setCookieHeaders) {
          if (cookieHeader.startsWith(`${cookieName}=`)) {
            // Extract the cookie value (before the first semicolon and after the equals sign)
            const cookieValue = cookieHeader.split(';')[0].split('=')[1];
            // URL decode and extract the token part (before the signature dot)
            const decodedValue = decodeURIComponent(cookieValue);
            // The signed cookie format is: value.signature
            verificationToken = decodedValue.split('.')[0];
            break;
          }
        }

        if (verificationToken) {
          // Clone the response to read the body
          const responseClone = response.clone();
          const responseBody = await responseClone.json();

          // Get user ID from response or session
          const userId = responseBody?.user?.id || sessionToken || 'anonymous';
          const type = relativePath.includes('register') ? 'registration' : 'authentication';

          // Store the mapping: challengeId → verificationToken
          const challengeId = await this.challengeService.storeChallengeMapping(
            verificationToken,
            userId,
            type as 'authentication' | 'registration',
          );

          // Add challengeId to the response body
          const enhancedBody = {
            ...responseBody,
            challengeId,
          };

          // Create new headers WITHOUT the Set-Cookie for the passkey challenge
          // (we don't want cookies in JWT mode)
          const newHeaders = new Headers();
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() !== 'set-cookie') {
              newHeaders.set(key, value);
            }
          });
          // Re-add non-passkey Set-Cookie headers
          for (const cookieHeader of setCookieHeaders) {
            if (!cookieHeader.startsWith(`${cookieName}=`)) {
              newHeaders.append('Set-Cookie', cookieHeader);
            }
          }

          // Create a new response with the enhanced body and filtered headers
          const enhancedResponse = new Response(JSON.stringify(enhancedBody), {
            headers: newHeaders,
            status: response.status,
            statusText: response.statusText,
          });

          this.logger.debug(`Stored challenge mapping with ID: ${challengeId.substring(0, 8)}...`);

          // Send the enhanced response
          await sendWebResponse(res, enhancedResponse);

          return;
        } else {
          this.logger.warn('Could not extract verificationToken from Set-Cookie header');
        }
      }

      // Clean up the used challenge mapping only after SUCCESSFUL verification
      // On failure, keep the challenge so the user can retry with a different passkey
      if (challengeIdToDelete && this.challengeService && response.ok) {
        await this.challengeService.deleteChallengeMapping(challengeIdToDelete);
      } else if (challengeIdToDelete && !response.ok) {
        this.logger.debug(`Keeping challenge mapping after failed verification (status=${response.status}) for retry`);
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
        const message = this.isProd ? 'Authentication error' : error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({
          error: 'Authentication handler error',
          message,
        });
      }
    }
  }
}
