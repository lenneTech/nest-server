import { CoreTokenData } from './core-token-data.interface';

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
   * Refresh tokens for different devices
   */
  refreshTokens?: Record<string, CoreTokenData>;

  /**
   * Temporary tokens for parallel requests during the token refresh process
   * See sameTokenIdPeriod in configuration
   */
  tempTokens?: Record<string, { createdAt: number; deviceId: string; tokenId: string }>;
}
