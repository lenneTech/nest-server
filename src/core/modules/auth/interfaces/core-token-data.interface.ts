/**
 * Data of the token
 */
export interface CoreTokenData {
  /**
   * Description of the device from which the token was generated
   */
  deviceDescription?: string;

  /**
   * ID of the device from which the token was generated
   */
  deviceId?: string;

  /**
   * Token ID to make sure that there is only one RefreshToken for each device
   */
  tokenId: string;
}
