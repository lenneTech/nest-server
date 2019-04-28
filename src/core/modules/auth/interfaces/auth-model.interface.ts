import { IAuthUser } from './auth-user.interface';

/**
 * Interface for auth guard
 */
export interface IAuthModel {
  token: string;
  user: IAuthUser;
}
