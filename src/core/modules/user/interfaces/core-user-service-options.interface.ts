import { CoreBetterAuthUserMapper } from '../../better-auth/core-better-auth-user.mapper';

/**
 * Optional configuration for CoreUserService
 *
 * Use this interface for optional dependencies that may not be available in all projects.
 * This pattern allows adding new optional parameters without breaking existing implementations.
 */
export interface CoreUserServiceOptions {
  /**
   * Optional CoreBetterAuthUserMapper for syncing between Legacy and IAM auth systems.
   * When provided, email changes and user deletions are automatically synced.
   */
  betterAuthUserMapper?: CoreBetterAuthUserMapper;
}
