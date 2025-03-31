import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { Response as ResponseType } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GraphQLServiceOptions } from '../../common/decorators/graphql-service-options.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ServiceOptions } from '../../common/interfaces/service-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { AuthGuardStrategy } from './auth-guard-strategy.enum';
import { CoreAuthModel } from './core-auth.model';
import { AuthGuard } from './guards/auth.guard';
import { CoreAuthSignInInput } from './inputs/core-auth-sign-in.input';
import { CoreAuthSignUpInput } from './inputs/core-auth-sign-up.input';
import { ICoreAuthUser } from './interfaces/core-auth-user.interface';
import { CoreAuthService } from './services/core-auth.service';
import { Tokens } from './tokens.decorator';

/**
 * Authentication resolver for the sign in
 */
@Resolver(() => CoreAuthModel, { isAbstract: true })
@Roles(RoleEnum.ADMIN)
export class CoreAuthResolver {
  /**
   * Import services
   */
  constructor(
    protected readonly authService: CoreAuthService,
    protected readonly configService: ConfigService,
  ) {}

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Logout user (from specific device)
   */
  @Mutation(() => Boolean, { description: 'Logout user (from specific device)' })
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  async logout(
    @CurrentUser() currentUser: ICoreAuthUser,
    @Context() ctx: { res: ResponseType },
    @Tokens('token') token: string,
    @Args('allDevices', { nullable: true }) allDevices?: boolean,
  ): Promise<boolean> {
    const result = await this.authService.logout(token, { allDevices, currentUser });
    return this.processCookies(ctx, result);
  }

  /**
   * Refresh token (for specific device)
   */
  @Mutation(() => CoreAuthModel, { description: 'Refresh tokens (for specific device)' })
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT_REFRESH))
  async refreshToken(
    @CurrentUser() user: ICoreAuthUser,
    @Tokens('refreshToken') refreshToken: string,
    @Context() ctx: { res: ResponseType },
  ): Promise<CoreAuthModel> {
    const result = await this.authService.refreshTokens(user, refreshToken);
    return this.processCookies(ctx, result);
  }

  /**
   * Sign in user via email and password (on specific device)
   */
  @Mutation(() => CoreAuthModel, {
    description: 'Sign in user via email and password and get JWT tokens (for specific device)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  async signIn(
    @GraphQLServiceOptions({ gqlPath: 'signIn.user' }) serviceOptions: ServiceOptions,
    @Context() ctx: { res: ResponseType },
    @Args('input') input: CoreAuthSignInInput,
  ): Promise<CoreAuthModel> {
    const result = await this.authService.signIn(input, serviceOptions);
    return this.processCookies(ctx, result);
  }

  /**
   * Register a new user account (on specific device)
   */
  @Mutation(() => CoreAuthModel, { description: 'Register a new user account (on specific device)' })
  @Roles(RoleEnum.S_EVERYONE)
  async signUp(
    @GraphQLServiceOptions({ gqlPath: 'signUp.user' }) serviceOptions: ServiceOptions,
    @Context() ctx: { res: ResponseType },
    @Args('input') input: CoreAuthSignUpInput,
  ): Promise<CoreAuthModel> {
    const result = await this.authService.signUp(input, serviceOptions);
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
      if (!result || typeof result !== 'object') {
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
