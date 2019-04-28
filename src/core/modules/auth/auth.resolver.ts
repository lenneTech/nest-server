import { Inject, mixin, Type } from '@nestjs/common';
import { Args, Query } from '@nestjs/graphql';
import { IAuthModel } from './interfaces/auth-model.interface';
import { IAuthResolver } from './interfaces/auth-resolver.interface';
import { IAuthService } from './interfaces/auth-service.interface';

/**
 * Create function for AuthResolver
 */
function createAuthResolver(authModelClass: Type<IAuthModel>): Type<IAuthResolver> {

  /**
   * Authentication resolver for the sign in
   */
  class MixinAuthResolver {

    /**
     * Import services
     */
    constructor(@Inject('AuthService') private readonly authService: IAuthService) {}

    // ===========================================================================
    // Queries
    // ===========================================================================

    /**
     * Get user via ID
     */
    @Query(returns => authModelClass, { description: 'Get JWT token' })
    async signIn(@Args('email') email: string, @Args('password') password: string): Promise<IAuthModel> {
      return await this.authService.signIn(email, password);
    }
  }

  const authResolver = mixin(MixinAuthResolver);
  return authResolver;
}

/**
 * Export AuthResolver
 */
export const AuthResolver = createAuthResolver;
