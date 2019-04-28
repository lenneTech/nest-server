/**
 * Interface for user with necessary properties for the AuthModule
 */
export interface IAuthUser {
  /**
   * Email address of the user
   */
  email: string;

  /**
   * Password of the user
   */
  password: string;
}
