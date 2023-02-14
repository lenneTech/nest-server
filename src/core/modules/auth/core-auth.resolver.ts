import { UseGuards } from '@nestjs/common';
import { Args, Context, Info, Mutation, Resolver } from '@nestjs/graphql';
import { Response as ResponseType } from 'express';
import { GraphQLResolveInfo } from 'graphql';
import { GraphQLUser } from '../../common/decorators/graphql-user.decorator';
import { ConfigService } from '../../common/services/config.service';
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
  constructor(protected readonly authService: CoreAuthService, protected readonly configService: ConfigService) {}

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Sign in user via email and password (on specific device)
   */
  @Mutation((returns) => CoreAuthModel, {
    description: 'Sign in user via email and password and get JWT tokens (for specific device)',
  })
  async signIn(
    @Info() info: GraphQLResolveInfo,
    @Context() ctx: { res: ResponseType },
    @Args('input') input: CoreAuthSignInInput
  ): Promise<CoreAuthModel> {
    const result = await this.authService.signIn(input, { fieldSelection: { info, select: 'signIn' } });
    return this.processCookies(ctx, result);
  }

  /**
   * Logout user (from specific device)
   */
  @Mutation((returns) => CoreAuthModel, { description: 'Logout user (from specific device)' })
  async logout(
    @GraphQLUser() currentUser: ICoreAuthUser,
    @Context() ctx: { res: ResponseType },
    @Args('deviceId', { nullable: true }) deviceId?: string
  ): Promise<boolean> {
    const result = await this.authService.logout({ currentUser, deviceId });
    return this.processCookies(ctx, result);
  }

  /**
   * Refresh token (for specific device)
   */
  @UseGuards(AuthGuard('jwt-refresh'))
  @Mutation((returns) => CoreAuthModel, { description: 'Refresh tokens (for specific device)' })
  async refreshToken(
    @GraphQLUser() user: ICoreAuthUser,
    @Context() ctx: { res: ResponseType },
    @Args('deviceId', { nullable: true }) deviceId?: string
  ): Promise<CoreAuthModel> {
    const result = await this.authService.refreshTokens(user, deviceId);
    return this.processCookies(ctx, result);
  }

  /**
   * Register a new user account (on specific device)
   */
  @Mutation((returns) => CoreAuthModel, { description: 'Register a new user account (on specific device)' })
  async signUp(
    @Info() info: GraphQLResolveInfo,
    @Context() ctx: { res: ResponseType },
    @Args('input') input: CoreAuthSignUpInput
  ): Promise<CoreAuthModel> {
    const result = await this.authService.signUp(input, { fieldSelection: { info, select: 'signUp' } });
    return this.processCookies(ctx, result);
  }

  // ===================================================================================================================
  // Helper
  // ===================================================================================================================

  /**
   * Process cookies
   */
  protected processCookies(ctx: { res: ResponseType }, result: any) {
    // Check if cookie handling is activated
    if (this.configService.getFastButReadOnly('cookies')) {
      // Set cookies
      if (typeof result !== 'object') {
        ctx.res.cookie('token', '', { httpOnly: true });
        ctx.res.cookie('refreshToken', '', { httpOnly: true });
        return result;
      }
      ctx.res.cookie('token', result?.token || '', { httpOnly: true });
      ctx.res.cookie('refreshToken', result?.refreshToken || '', { httpOnly: true });

      // Remove tokens from result
      if (result.token) {
        delete result.token;
      }
      if (result.refreshToken) {
        delete result.refreshToken;
      }
    }

    // Return prepared result
    return result;
  }
}
