import { Logger } from '@nestjs/common';
import { Response } from 'express';

import { signCookieValue } from './core-better-auth-web.helper';

/**
 * Standard cookie names used by Better-Auth and nest-server.
 *
 * ## Cookie Strategy (v11.12+)
 *
 * | Cookie Name | Purpose | When Set |
 * |-------------|---------|----------|
 * | `{basePath}.session_token` | Better-Auth's native cookie (e.g., `iam.session_token`) | Always |
 * | `token` | Legacy compatibility for < 11.7.0 | Only if Legacy Auth is active |
 *
 * This is a significant reduction from previous versions (4-5 cookies → 1-2 cookies).
 */
export const AUTH_COOKIE_NAMES = {
  /** Primary token cookie for nest-server compatibility (Legacy Auth) */
  TOKEN: 'token',
} as const;

/**
 * Cookie options for authentication cookies.
 */
export interface AuthCookieOptions {
  httpOnly: boolean;
  maxAge?: number;
  sameSite: 'lax' | 'none' | 'strict';
  secure: boolean;
}

/**
 * Configuration for BetterAuthCookieHelper.
 */
export interface BetterAuthCookieHelperConfig {
  /** Base path for Better-Auth (e.g., '/iam' or 'iam') */
  basePath: string;
  /**
   * Enable legacy 'token' cookie for backwards compatibility with < 11.7.0.
   * Only needed when Legacy Auth (Passport) is also active.
   * @default false (auto-detected based on Legacy Auth activation)
   */
  legacyCookieEnabled?: boolean;
  /** Logger instance for debug output */
  logger?: Logger;
  /**
   * Secret for signing cookies.
   * Better-Auth expects signed cookies in format: value.signature
   * CRITICAL: Required for Passkey/2FA to work correctly.
   */
  secret?: string;
}

/**
 * Response object containing session information for cookie processing.
 */
export interface CookieProcessingResult {
  /** Session information */
  session?: { id: string };
  /** Session token to set in cookies */
  token?: string;
}

/**
 * Centralized helper for Better-Auth cookie operations.
 *
 * This class consolidates all cookie-related logic to ensure consistency
 * across the controller and middlewares. It handles:
 * - Setting session cookies for Better-Auth
 * - Optional legacy cookie for backwards compatibility
 * - Clearing authentication cookies
 * - Extracting session tokens from responses
 *
 * ## Cookie Strategy (v11.12+)
 *
 * Only the minimum required cookies are set:
 *
 * | Cookie Name | Purpose | When Set |
 * |-------------|---------|----------|
 * | `{basePath}.session_token` | Better-Auth's native cookie (CRITICAL for Passkey/2FA) | Always |
 * | `token` | Legacy compatibility | Only if `legacyCookieEnabled: true` |
 *
 * **Vorher:** 4-5 Cookies (`token`, `iam.session_token`, `better-auth.session_token`, `session`, optional)
 * **Nachher:** 1-2 Cookies (`iam.session_token`, optional `token` for Legacy)
 *
 * @example
 * ```typescript
 * const cookieHelper = new BetterAuthCookieHelper({
 *   basePath: '/iam',
 *   legacyCookieEnabled: !!jwtConfig?.secret, // Auto-detect Legacy Auth
 *   logger: this.logger,
 * });
 *
 * // In sign-in handler
 * cookieHelper.setSessionCookies(res, sessionToken);
 *
 * // In sign-out handler
 * cookieHelper.clearSessionCookies(res);
 * ```
 */
export class BetterAuthCookieHelper {
  private readonly normalizedBasePath: string;
  private readonly cookieName: string;

  constructor(private readonly config: BetterAuthCookieHelperConfig) {
    // Normalize basePath: remove leading slash, replace slashes with dots
    this.normalizedBasePath = config.basePath.replace(/^\//, '').replace(/\//g, '.');
    // Default cookie name based on basePath (e.g., 'iam.session_token')
    this.cookieName = `${this.normalizedBasePath}.session_token`;
  }

  /**
   * Gets the default cookie options for authentication cookies.
   *
   * @returns Cookie options with httpOnly, sameSite, and secure settings
   */
  getDefaultCookieOptions(): AuthCookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    };
  }

  /**
   * Gets the normalized base path (e.g., 'iam' from '/iam').
   */
  getNormalizedBasePath(): string {
    return this.normalizedBasePath;
  }

  /**
   * Gets the cookie name based on the base path.
   * This is the ONLY required cookie for Better-Auth.
   */
  getCookieName(): string {
    return this.cookieName;
  }

  /**
   * Sets session cookies on the response for authentication.
   *
   * Sets the minimum required cookies:
   * 1. `{basePath}.session_token` - Better-Auth's native cookie (REQUIRED)
   *    This is CRITICAL for Passkey/WebAuthn and 2FA to work.
   * 2. `token` - Legacy cookie (OPTIONAL, only if legacyCookieEnabled)
   *
   * IMPORTANT: Cookies are SIGNED using Better-Auth's secret.
   * Better-Auth expects signed cookies in format: value.signature
   * Without signing, Passkey and 2FA will fail with 401 errors.
   *
   * @param res - Express Response object
   * @param sessionToken - The session token to set
   * @param _sessionId - Deprecated, kept for API compatibility but no longer used
   */
  setSessionCookies(res: Response, sessionToken: string, _sessionId?: string): void {
    const cookieOptions = this.getDefaultCookieOptions();

    // Sign the session token for Better-Auth
    // CRITICAL: Without signing, Better-Auth cannot validate sessions
    let cookieValue: string;
    if (this.config.secret) {
      cookieValue = signCookieValue(sessionToken, this.config.secret);
    } else {
      this.config.logger?.warn('No secret configured - setting unsigned cookie (Passkey/2FA may fail)');
      cookieValue = sessionToken;
    }

    // Set Better-Auth's native session token cookie
    // This is the ONLY required cookie for all Better-Auth features
    res.cookie(this.cookieName, cookieValue, cookieOptions);

    // Legacy 'token' cookie only if Legacy Auth is active (< 11.7.0 compatibility)
    // Note: Legacy cookie uses UNSIGNED value (Legacy Auth doesn't use signing)
    if (this.config.legacyCookieEnabled) {
      res.cookie(AUTH_COOKIE_NAMES.TOKEN, sessionToken, cookieOptions);
    }
  }

  /**
   * Clears all authentication cookies from the response.
   *
   * This method clears both the native cookie and the legacy cookie
   * (if it was potentially set).
   *
   * @param res - Express Response object
   */
  clearSessionCookies(res: Response): void {
    const cookieOptions: AuthCookieOptions = {
      ...this.getDefaultCookieOptions(),
      maxAge: 0,
    };

    // Clear Better-Auth's native cookie
    res.cookie(this.cookieName, '', cookieOptions);

    // Clear legacy cookie if it was potentially set
    if (this.config.legacyCookieEnabled) {
      res.cookie(AUTH_COOKIE_NAMES.TOKEN, '', cookieOptions);
    }
  }

  /**
   * Extracts the session token from a Web Response's Set-Cookie headers.
   *
   * This method parses the Set-Cookie headers from a Better-Auth response
   * and extracts the session token value.
   *
   * @param response - Web Standard Response from Better-Auth
   * @returns The session token or null if not found
   */
  extractSessionTokenFromResponse(response: globalThis.Response): null | string {
    try {
      const setCookieHeaders = response.headers.getSetCookie?.() || [];

      // Look for session token in the native cookie name
      for (const cookieHeader of setCookieHeaders) {
        if (cookieHeader.startsWith(`${this.cookieName}=`)) {
          // Extract the cookie value (before the first semicolon, after the equals sign)
          const cookieValue = cookieHeader.split(';')[0].split('=').slice(1).join('=');

          // URL decode to get the raw value
          let sessionToken: string;
          try {
            sessionToken = decodeURIComponent(cookieValue);
          } catch {
            sessionToken = cookieValue;
          }

          // If it's a signed cookie (value.signature), extract just the value
          // Note: Don't confuse with JWTs which have 2 dots (3 parts)
          const parts = sessionToken.split('.');
          if (parts.length === 2) {
            // Signed cookie format: value.signature
            return parts[0];
          }

          return sessionToken;
        }
      }

      return null;
    } catch (error) {
      this.config.logger?.debug(
        `Failed to extract session token from response: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Sets compatibility session cookies from a Web Response.
   *
   * This method extracts the session token from a Better-Auth response
   * and sets all compatibility cookies on the Express response.
   * Used by middleware to ensure consistent cookie behavior after passkey auth.
   *
   * @param res - Express Response object
   * @param webResponse - Web Standard Response from Better-Auth
   */
  setSessionCookiesFromWebResponse(res: Response, webResponse: globalThis.Response): void {
    const sessionToken = this.extractSessionTokenFromResponse(webResponse);

    if (!sessionToken) {
      return;
    }

    // Set session cookies
    this.setSessionCookies(res, sessionToken);
  }

  /**
   * Processes a result object by setting appropriate cookies and removing token from body.
   *
   * This method handles the common pattern of:
   * 1. Setting cookies if cookie handling is enabled
   * 2. Removing the token from the response body (it's now in cookies)
   *
   * @param res - Express Response object
   * @param result - The result object to process (modified in place)
   * @param cookiesEnabled - Whether cookie handling is enabled (from config)
   * @returns The modified result (same reference as input)
   */
  processAuthResult<T extends CookieProcessingResult>(res: Response, result: T, cookiesEnabled: boolean): T {
    if (!cookiesEnabled) {
      return result;
    }

    if (result.token) {
      // Set cookies
      this.setSessionCookies(res, result.token);

      // Remove token from response body (it's now in cookies)
      delete result.token;
    }

    return result;
  }
}

/**
 * Creates a BetterAuthCookieHelper instance with common configuration.
 *
 * Utility function for quick instantiation with typical settings.
 *
 * @param basePath - Base path for Better-Auth
 * @param options - Configuration options (legacyCookieEnabled, secret, etc.)
 * @param logger - Optional logger instance
 * @returns Configured BetterAuthCookieHelper instance
 */
export function createCookieHelper(
  basePath: string,
  options?: { legacyCookieEnabled?: boolean; secret?: string },
  logger?: Logger,
): BetterAuthCookieHelper {
  return new BetterAuthCookieHelper({
    basePath,
    legacyCookieEnabled: options?.legacyCookieEnabled ?? false,
    logger,
    secret: options?.secret,
  });
}
