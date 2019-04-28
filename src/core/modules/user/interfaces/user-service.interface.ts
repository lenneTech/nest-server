import { FilterArgs } from '../../../..';
import { IUser } from './user.interface';

/**
 * Interface for UserService
 */
export interface IUserService {
  /**
   * User repository
   */
  readonly db: any;

  /**
   * Create user
   */
  create(input: any): Promise<IUser>;

  /**
   * Get user via ID
   */
  get(id: string): Promise<IUser>;

  /**
   * Get user via email
   */
  getViaEmail(email: string): Promise<IUser>;

  /**
   * Get users via filter
   */
  find(filterArgs?: FilterArgs): Promise<IUser[]>;

  /**
   * Get user via ID
   */
  update(id: string, input: any): Promise<IUser>;

  /**
   * Delete user via ID
   */
  delete(id: string): Promise<IUser>;
}
