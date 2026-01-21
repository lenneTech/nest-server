/**
 * Type definitions for Better-Auth API responses
 *
 * These types provide type safety for interactions with the Better-Auth API
 * and reduce the need for `as any` casts throughout the codebase.
 */

import { Types } from 'mongoose';

import { BetterAuthSessionUser } from './core-better-auth-user.mapper';

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
 * Authenticated user object created from BetterAuth token verification.
 *
 * This interface represents a user that has been authenticated via BetterAuth
 * (either JWT or session token). It includes the `hasRole` method for
 * role-based access control and the `_authenticatedViaBetterAuth` flag
 * to identify BetterAuth-authenticated users.
 */
export interface BetterAuthenticatedUser {
  /** Allow additional properties from MongoDB document */
  [key: string]: unknown;
  /** Flag indicating this user was authenticated via BetterAuth */
  _authenticatedViaBetterAuth: true;
  /** MongoDB _id field */
  _id?: Types.ObjectId;
  /** User's email address */
  email: string;
  /** Whether user's email is verified */
  emailVerified?: boolean;
  /**
   * Check if user has any of the specified roles
   * @param roles - Array of role names to check
   * @returns true if user has at least one of the roles
   */
  hasRole: (roles: string[]) => boolean;
  /** User ID as string */
  id: string;
  /** User's assigned roles */
  roles?: string[];
  /** Whether the user is verified */
  verified?: boolean;
  /** Timestamp when user was verified */
  verifiedAt?: Date;
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
 * Includes optional token for Better Auth session authentication
 */
export function hasSession<T>(response: T): response is T & { session: { expiresAt: Date; id: string; token?: string } } {
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
