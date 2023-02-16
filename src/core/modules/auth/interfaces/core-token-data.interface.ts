/**
 * Data of the token
 */
export interface CoreTokenData {
  /**
   * ID of the device from which the token was generated
   */
  deviceId?: string;

  /**
   * Description of the device from which the token was generated
   */
  deviceDescription?: string;

  /**
   * Token ID to make sure that there is only one RefreshToken for each device
   */
  tokenId: string;
}
