import { Args, Info, Query, Resolver } from '@nestjs/graphql';
import { GraphQLResolveInfo } from 'graphql';
import { CoreAuthModel } from './core-auth.model';
import { CoreAuthService } from './services/core-auth.service';

/**
 * Authentication resolver for the sign in
 */
@Resolver((of) => CoreAuthModel, { isAbstract: true })
export class CoreAuthResolver {
  /**
   * Import services
   */
  constructor(protected readonly authService: CoreAuthService) {}

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get user via ID
   */
  @Query((returns) => CoreAuthModel, { description: 'Get JWT token' })
  async signIn(
    @Args('email') email: string,
    @Args('password') password: string,
    @Info() info: GraphQLResolveInfo
  ): Promise<Partial<CoreAuthModel>> {
    return await this.authService.signIn(email, password, { fieldSelection: { info, select: 'signIn' } });
  }
}
