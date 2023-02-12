import { UseGuards } from '@nestjs/common';
import { Args, Info, Mutation, Resolver } from '@nestjs/graphql';
import { GraphQLResolveInfo } from 'graphql';
import { GraphQLUser } from '../../common/decorators/graphql-user.decorator';
import { CoreAuthModel } from './core-auth.model';
import { AuthGuard } from './guards/auth.guard';
import { CoreAuthSignInInput } from './inputs/core-auth-sign-in.input';
import { CoreAuthSignUpInput } from './inputs/core-auth-sign-up.input';
import { ICoreAuthUser } from './interfaces/core-auth-user.interface';
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
  // Mutations
  // ===========================================================================

  /**
   * Sign in user via email and password (on specific device)
   */
  @Mutation((returns) => CoreAuthModel, {
    description: 'Sign in user via email and password and get JWT tokens (for specific device)',
  })
  async signIn(@Info() info: GraphQLResolveInfo, @Args('input') input: CoreAuthSignInInput): Promise<CoreAuthModel> {
    return await this.authService.signIn(input, { fieldSelection: { info, select: 'signIn' } });
  }

  /**
   * Logout user (from specific device)
   */
  @Mutation((returns) => CoreAuthModel, { description: 'Logout user (from specific device)' })
  async logout(
    @GraphQLUser() currentUser: ICoreAuthUser,
    @Args('deviceId', { nullable: true }) deviceId?: string
  ): Promise<boolean> {
    return await this.authService.logout({ currentUser, deviceId });
  }

  /**
   * Refresh token (for specific device)
   */
  @UseGuards(AuthGuard('jwt-refresh'))
  @Mutation((returns) => CoreAuthModel, { description: 'Refresh tokens (for specific device)' })
  async refreshToken(
    @GraphQLUser() user: ICoreAuthUser,
    @Args('deviceId', { nullable: true }) deviceId?: string
  ): Promise<CoreAuthModel> {
    return await this.authService.refreshTokens(user, deviceId);
  }

  /**
   * Register a new user account (on specific device)
   */
  @Mutation((returns) => CoreAuthModel, { description: 'Register a new user account (on specific device)' })
  async signUp(@Info() info: GraphQLResolveInfo, @Args('input') input: CoreAuthSignUpInput): Promise<CoreAuthModel> {
    return await this.authService.signUp(input, { fieldSelection: { info, select: 'signUp' } });
  }
}
