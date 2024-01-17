/**
 * Interface for jwt payload
 */
export interface JwtPayload {
  [key: string]: any;
  deviceId: string;
  id: string;
  tokenId: string;
}
