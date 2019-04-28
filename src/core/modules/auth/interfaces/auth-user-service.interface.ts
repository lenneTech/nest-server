import { IAuthUser } from './auth-user.interface';

/**
 * Interface for user services used for authorization
 */
export interface IAuthUserService {
  getViaEmail(email: string): Promise<IAuthUser>;
}
