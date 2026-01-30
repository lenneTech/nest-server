import { Logger } from '@nestjs/common';
import { Response } from 'express';

/**
 * Standard cookie names used by Better-Auth and nest-server.
 */
export const AUTH_COOKIE_NAMES = {
  /** Legacy Better-Auth session token cookie (backwards compatibility) */
  BETTER_AUTH_SESSION: 'better-auth.session_token',
  /** Session ID cookie for reference/debugging */
  SESSION: 'session',
  /** Primary token cookie for nest-server compatibility */
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
  /** Custom cookie name from Better-Auth config (optional) */
  configuredCookieName?: string;
  /** Logger instance for debug output */
  logger?: Logger;
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
 * - Setting multiple session cookies for compatibility
 * - Clearing authentication cookies
 * - Extracting session tokens from responses
 * - Base path normalization
 *
 * ## Cookie Strategy
 *
 * Multiple cookies are set for maximum compatibility:
 *
 * | Cookie Name | Purpose |
 * |-------------|---------|
 * | `token` | Primary session token (nest-server compatibility) |
 * | `{basePath}.session_token` | Better-Auth's native cookie (e.g., `iam.session_token`) |
 * | `better-auth.session_token` | Legacy Better-Auth cookie (backwards compatibility) |
 * | `{configured}` | Custom cookie name if configured |
 * | `session` | Session ID for reference/debugging |
 *
 * @example
 * ```typescript
 * const cookieHelper = new BetterAuthCookieHelper({
 *   basePath: '/iam',
 *   configuredCookieName: betterAuthConfig?.options?.advanced?.cookies?.session_token?.name,
 *   logger: this.logger,
 * });
 *
 * // In sign-in handler
 * cookieHelper.setSessionCookies(res, sessionToken, sessionId);
 *
 * // In sign-out handler
 * cookieHelper.clearSessionCookies(res);
 * ```
 */
export class BetterAuthCookieHelper {
  private readonly normalizedBasePath: string;
  private readonly defaultCookieName: string;

  constructor(private readonly config: BetterAuthCookieHelperConfig) {
    // Normalize basePath: remove leading slash, replace slashes with dots
    this.normalizedBasePath = config.basePath.replace(/^\//, '').replace(/\//g, '.');
    // Default cookie name based on basePath (e.g., 'iam.session_token')
    this.defaultCookieName = `${this.normalizedBasePath}.session_token`;
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
   * Gets the default cookie name based on the base path.
   */
  getDefaultCookieName(): string {
    return this.defaultCookieName;
  }

  /**
   * Sets session cookies on the response for authentication.
   *
   * This method sets multiple cookies to ensure compatibility with:
   * - nest-server's existing authentication flow (`token` cookie)
   * - Better-Auth's native plugin system (basePath-based cookie)
   * - Legacy Better-Auth implementations (`better-auth.session_token`)
   * - Custom cookie configurations
   *
   * @param res - Express Response object
   * @param sessionToken - The session token to set
   * @param sessionId - Optional session ID for the session cookie
   */
  setSessionCookies(res: Response, sessionToken: string, sessionId?: string): void {
    const cookieOptions = this.getDefaultCookieOptions();

    // Set the primary token cookie (nest-server compatibility)
    res.cookie(AUTH_COOKIE_NAMES.TOKEN, sessionToken, cookieOptions);

    // Set Better-Auth's native session token cookie for plugin compatibility
    // This is CRITICAL for Passkey/WebAuthn to work
    res.cookie(this.defaultCookieName, sessionToken, cookieOptions);

    // Set the legacy cookie name for backwards compatibility
    res.cookie(AUTH_COOKIE_NAMES.BETTER_AUTH_SESSION, sessionToken, cookieOptions);

    // Set configured cookie name if different from defaults
    if (this.shouldSetConfiguredCookie()) {
      res.cookie(this.config.configuredCookieName!, sessionToken, cookieOptions);
    }

    // Set session ID cookie (for reference/debugging)
    if (sessionId) {
      res.cookie(AUTH_COOKIE_NAMES.SESSION, sessionId, cookieOptions);
    }

    this.config.logger?.debug('Set session cookies for authentication');
  }

  /**
   * Clears all authentication cookies from the response.
   *
   * This method clears all known cookie names to ensure complete logout.
   *
   * @param res - Express Response object
   */
  clearSessionCookies(res: Response): void {
    const cookieOptions: AuthCookieOptions = {
      ...this.getDefaultCookieOptions(),
      maxAge: 0,
    };

    // Clear primary cookies
    res.cookie(AUTH_COOKIE_NAMES.TOKEN, '', cookieOptions);
    res.cookie(AUTH_COOKIE_NAMES.SESSION, '', cookieOptions);
    res.cookie(AUTH_COOKIE_NAMES.BETTER_AUTH_SESSION, '', cookieOptions);

    // Clear the path-based session token cookie
    res.cookie(this.defaultCookieName, '', cookieOptions);

    // Clear configured cookie name if different from defaults
    if (this.shouldSetConfiguredCookie()) {
      res.cookie(this.config.configuredCookieName!, '', cookieOptions);
    }

    this.config.logger?.debug('Cleared all authentication cookies');
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

      // Look for session token in known cookie names
      for (const cookieHeader of setCookieHeaders) {
        if (
          cookieHeader.startsWith(`${this.defaultCookieName}=`) ||
          cookieHeader.startsWith(`${AUTH_COOKIE_NAMES.BETTER_AUTH_SESSION}=`)
        ) {
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
      this.config.logger?.debug('No session token found in response cookies');
      return;
    }

    // Set all compatibility cookies (without session ID since we don't have it)
    this.setSessionCookies(res, sessionToken);
  }

  /**
   * Processes a result object by setting appropriate cookies and removing token from body.
   *
   * This method handles the common pattern of:
   * 1. Setting cookies if cookie handling is enabled
   * 2. Removing the token from the response body (it's now in cookies)
   * 3. Setting session ID cookie if available
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
      this.setSessionCookies(res, result.token, result.session?.id);

      // Remove token from response body (it's now in cookies)
      delete result.token;
    } else if (result.session?.id) {
      // No token but has session - just set session cookie
      const cookieOptions = this.getDefaultCookieOptions();
      res.cookie(AUTH_COOKIE_NAMES.SESSION, result.session.id, cookieOptions);
    }

    return result;
  }

  /**
   * Checks if the configured cookie name should be set.
   *
   * Returns true if a custom cookie name is configured and it's different
   * from the default names (to avoid duplicates).
   */
  private shouldSetConfiguredCookie(): boolean {
    const configured = this.config.configuredCookieName;
    return !!(configured && configured !== AUTH_COOKIE_NAMES.TOKEN && configured !== this.defaultCookieName);
  }
}

/**
 * Creates a BetterAuthCookieHelper instance with common configuration.
 *
 * Utility function for quick instantiation with typical settings.
 *
 * @param basePath - Base path for Better-Auth
 * @param configuredCookieName - Optional custom cookie name
 * @param logger - Optional logger instance
 * @returns Configured BetterAuthCookieHelper instance
 */
export function createCookieHelper(
  basePath: string,
  configuredCookieName?: string,
  logger?: Logger,
): BetterAuthCookieHelper {
  return new BetterAuthCookieHelper({
    basePath,
    configuredCookieName,
    logger,
  });
}
