import { FilterArgs, UserCreateInput, UserInput } from '../../../..';
import { IUser } from './user.interface';

/**
 * Interface of UserResolver
 */
export interface IUserResolver {

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get user via ID
   */
  getUser(id: string): Promise<IUser>;

  /**
   * Get users (via filter)
   */
  findUsers(args?: FilterArgs): Promise<IUser[]>;

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Create new user
   */
  createUser(input: UserCreateInput): Promise<IUser>;

  /**
   * Update existing user
   */
  updateUser(input: UserInput, id: string): Promise<IUser>;

  /**
   * Delete existing user
   */
  deleteUser(id: string): Promise<IUser>;

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  /**
   * Subscritption for create user
   */
  userCreated(): void;
}
