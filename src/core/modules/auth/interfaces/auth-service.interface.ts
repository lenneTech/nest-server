import { IJwtPayload } from './jwt-payload.interface';

/**
 * Interface for authorization service
 */
export interface IAuthService {

  /**
   * User sign in via email
   */
  signIn(email: string, password: string, ...params: any[]): any;

  /**
   * Validate user
   */
  validateUser(payload: IJwtPayload, ...params: any[]): any;
}
