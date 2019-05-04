import { Args, Query, Resolver } from '@nestjs/graphql';
import { CoreAuthResolver } from '../../../core/modules/auth/core-auth.resolver';
import { Auth } from './auth.model';

/**
 * Authentication resolver for the sign in
 */
@Resolver(of => Auth)
export class AuthResolver extends CoreAuthResolver {

  /**
   * Get user via ID
   */
  @Query(returns => Auth, { description: 'Get JWT token' })
  async signIn(@Args('email') email: string, @Args('password') password: string): Promise<Auth> {
    return await this.authService.signIn(email, password) as Auth;
  }
}
