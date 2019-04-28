import { IPersistenceModel } from '../../../common/interfaces/persistence-model.interface';

/**
 * Interface for core user
 */
export interface IUser extends IPersistenceModel {

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * E-Mail address of the user
   */
  email: string;

  /**
   * First name of the user
   */
  firstName?: string;

  /**
   * Last name of the user
   */
  lastName?: string;

  /**
   * Password of the user
   */
  password: string;

  /**
   * Roles of the user
   */
  roles: string[];

  /**
   * Username of the user
   */
  username?: string;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Checks whether the user has at least one of the required roles
   */
  hasRole(roles: string[]): boolean;

  /**
   * Checks whether the user has all required roles
   */
  hasAllRoles(roles: string[]): boolean;
}
