/**
 * Interface for user used in authorization module
 */
export interface ICoreAuthUser {
  /**
   * ID of the user
   */
  id: string;

  /**
   * Email of the user
   */
  email: string;

  /**
   * Password of the user
   */
  password: string;

  /**
   * Refresh token
   */
  refreshToken?: string;

  /**
   * Refresh tokens for different devices
   */
  refreshTokens?: Record<string, string>;
}
