/**
 * Type definitions for Better-Auth API responses
 *
 * These types provide type safety for interactions with the Better-Auth API
 * and reduce the need for `as any` casts throughout the codebase.
 */

import { BetterAuthSessionUser } from './better-auth-user.mapper';

/**
 * Better-Auth 2FA verification response
 */
export interface BetterAuth2FAResponse {
  /**
   * JWT access token (only when JWT plugin is enabled)
   */
  accessToken?: string;
  session?: BetterAuthSessionResponse['session'];
  /**
   * Session token (random string, not a JWT)
   */
  token?: string;
  user?: BetterAuthSessionUser;
}

/**
 * Better-Auth session response from getSession API
 */
export interface BetterAuthSessionResponse {
  session: {
    createdAt: Date;
    expiresAt: Date;
    id: string;
    token: string;
    updatedAt: Date;
    userId: string;
  };
  user: BetterAuthSessionUser;
}

/**
 * Better-Auth sign-in response
 */
export interface BetterAuthSignInResponse {
  /**
   * JWT access token (only when JWT plugin is enabled)
   * This is the actual JWT token to use for API authentication
   */
  accessToken?: string;
  session?: BetterAuthSessionResponse['session'];
  /**
   * Session token (random string, not a JWT)
   * This is the session identifier, not used for API authentication
   */
  token?: string;
  twoFactorRedirect?: boolean;
  user?: BetterAuthSessionUser;
}

/**
 * Better-Auth sign-up response
 */
export interface BetterAuthSignUpResponse {
  session?: BetterAuthSessionResponse['session'];
  user?: BetterAuthSessionUser;
}

/**
 * Type guard to check if response has session
 * Preserves the original type while asserting session is defined
 */
export function hasSession<T>(response: T): response is T & { session: { expiresAt: Date; id: string } } {
  return (
    response !== null &&
    typeof response === 'object' &&
    'session' in response &&
    (response as { session?: unknown }).session !== null &&
    (response as { session?: unknown }).session !== undefined
  );
}

/**
 * Type guard to check if response has user
 * Preserves the original type while asserting user is defined
 */
export function hasUser<T>(response: T): response is T & { user: BetterAuthSessionUser } {
  return (
    response !== null &&
    typeof response === 'object' &&
    'user' in response &&
    (response as { user?: unknown }).user !== null &&
    (response as { user?: unknown }).user !== undefined
  );
}

/**
 * Type guard to check if response requires 2FA
 */
export function requires2FA<T>(response: T): response is T & { twoFactorRedirect: true } {
  return (
    response !== null &&
    typeof response === 'object' &&
    'twoFactorRedirect' in response &&
    (response as { twoFactorRedirect?: boolean }).twoFactorRedirect === true
  );
}
