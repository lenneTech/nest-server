import { Args, Query, Resolver } from '@nestjs/graphql';
import { Auth } from './auth.model';
import { AuthService } from './auth.service';

@Resolver(of => Auth)
export class AuthResolver {

  /**
   * Import services
   */
  constructor(private readonly authService: AuthService) {}

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get user via ID
   */
  @Query(returns => Auth, { description: 'Get JWT token' })
  async signIn(@Args('email') email: string, @Args('password') password: string): Promise<Auth> {
    return await this.authService.signIn(email, password);
  }
}
