import { ICoreAuthUser } from '../interfaces/core-auth-user.interface';

/**
 * Abstract class for user service in authorization module
 */
export abstract class CoreAuthUserService {

  /**
   * Get user via email
   */
  abstract getViaEmail(email: string): Promise<ICoreAuthUser>;
}
