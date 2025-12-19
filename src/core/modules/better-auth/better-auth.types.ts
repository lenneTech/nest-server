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
  session?: BetterAuthSessionResponse['session'];
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
  session?: BetterAuthSessionResponse['session'];
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
 */
export function hasSession<T extends { session?: BetterAuthSessionResponse['session'] }>(
  response: T,
): response is T & { session: BetterAuthSessionResponse['session'] } {
  return response?.session !== undefined && response.session !== null;
}

/**
 * Type guard to check if response has user
 */
export function hasUser<T extends { user?: BetterAuthSessionUser }>(
  response: T,
): response is T & { user: BetterAuthSessionUser } {
  return response?.user !== undefined && response.user !== null;
}

/**
 * Type guard to check if response requires 2FA
 */
export function requires2FA(response: BetterAuthSignInResponse): boolean {
  return response?.twoFactorRedirect === true;
}
