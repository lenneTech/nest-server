/**
 * Interface for jwt payload
 */
export interface JwtPayload {
  [key: string]: any;
  id: string;
  deviceId: string;
  tokenId: string;
}
