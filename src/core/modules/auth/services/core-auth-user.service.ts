import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { ICoreAuthUser } from '../interfaces/core-auth-user.interface';

/**
 * Abstract class for user service in authorization module
 */
export abstract class CoreAuthUserService {
  /**
   * Get user via email
   */
  abstract getViaEmail(email: string, serviceOptions?: ServiceOptions): Promise<ICoreAuthUser>;

  /**
   * Prepare output
   */
  abstract prepareOutput(output: any, options?: ServiceOptions): Promise<ICoreAuthUser>;
}
