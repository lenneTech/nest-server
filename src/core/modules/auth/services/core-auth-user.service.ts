import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { ICoreAuthUser } from '../interfaces/core-auth-user.interface';

/**
 * Abstract class for user service in authorization module
 */
export abstract class CoreAuthUserService {
  /**
   * Create user
   */
  abstract create(input: any, serviceOptions?: ServiceOptions): Promise<ICoreAuthUser>;

  /**
   * Get user via ID
   */
  abstract get(id: string, serviceOptions?: ServiceOptions): Promise<ICoreAuthUser>;

  /**
   * Get user via email
   */
  abstract getViaEmail(email: string, serviceOptions?: ServiceOptions): Promise<ICoreAuthUser>;

  /**
   * Prepare output
   */
  abstract prepareOutput(output: any, options?: ServiceOptions): Promise<ICoreAuthUser>;

  /**
   * Update user
   */
  abstract update(id: string, input: any, serviceOptions?: ServiceOptions): Promise<ICoreAuthUser>;
}
