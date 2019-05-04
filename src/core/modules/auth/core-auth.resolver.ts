import { Args, Query } from '@nestjs/graphql';
import { Resolver } from 'type-graphql/dist/decorators/Resolver';
import { Auth } from '../../../server/modules/auth/auth.model';
import { CoreAuth } from './core-auth.model';
import { CoreAuthService } from './services/core-auth.service';

/**
 * Authentication resolver for the sign in
 */
@Resolver(of => Auth, {isAbstract: true})
export class CoreAuthResolver {

  /**
   * Import services
   */
  constructor(private readonly authService: CoreAuthService) {}

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get user via ID
   */
  @Query(returns => CoreAuth, { description: 'Get JWT token' })
  async signIn(@Args('email') email: string, @Args('password') password: string): Promise<CoreAuth> {
    return await this.authService.signIn(email, password);
  }
}
