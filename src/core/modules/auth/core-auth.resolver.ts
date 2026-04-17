import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { Response as ResponseType } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GraphQLServiceOptions } from '../../common/decorators/graphql-service-options.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { setLegacyAuthCookies } from '../../common/helpers/cookies.helper';
import type { ICookiesConfig } from '../../common/interfaces/server-options.interface';
import { ServiceOptions } from '../../common/interfaces/service-options.interface';
import { ConfigService } from '../../common/services/config.service';
import { AuthGuardStrategy } from './auth-guard-strategy.enum';
import { CoreAuthModel } from './core-auth.model';
import { LegacyAuthDisabledException } from './exceptions/legacy-auth-disabled.exception';
import { AuthGuard } from './guards/auth.guard';
import { LegacyAuthRateLimitGuard } from './guards/legacy-auth-rate-limit.guard';
import { CoreAuthSignInInput } from './inputs/core-auth-sign-in.input';
import { CoreAuthSignUpInput } from './inputs/core-auth-sign-up.input';
import { ICoreAuthUser } from './interfaces/core-auth-user.interface';
import { CoreAuthService } from './services/core-auth.service';
import { Tokens } from './tokens.decorator';

/**
 * Authentication resolver for the sign in
 *
 * This resolver provides Legacy Auth endpoints via GraphQL.
 * In a future version, BetterAuth (IAM) will become the default.
 *
 * ## Disabling Legacy Endpoints
 *
 * After all users have migrated to BetterAuth (IAM), these endpoints
 * can be disabled via configuration:
 *
 * ```typescript
 * auth: {
 *   legacyEndpoints: {
 *     enabled: false, // Disable all legacy endpoints
 *     // or
 *     graphql: false  // Disable only GraphQL endpoints
 *   }
 * }
 * ```
 *
 * @see https://github.com/lenneTech/nest-server/blob/develop/.claude/rules/module-deprecation.md
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
  // Helper - Legacy Endpoint Check
  // ===========================================================================

  /**
   * Check if legacy GraphQL endpoints are enabled
   *
   * Throws LegacyAuthDisabledException if:
   * - config.auth.legacyEndpoints.enabled is false
   * - config.auth.legacyEndpoints.graphql is false
   *
   * @throws LegacyAuthDisabledException
   */
  protected checkLegacyGraphQLEnabled(endpointName: string): void {
    const authConfig = this.configService.getFastButReadOnly('auth');
    const legacyConfig = authConfig?.legacyEndpoints;

    // Check if legacy endpoints are globally disabled
    if (legacyConfig?.enabled === false) {
      throw new LegacyAuthDisabledException(endpointName);
    }

    // Check if GraphQL endpoints specifically are disabled
    if (legacyConfig?.graphql === false) {
      throw new LegacyAuthDisabledException(endpointName);
    }
  }

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Logout user (from specific device)
   *
   * @deprecated Will be replaced by BetterAuth signOut in a future version
   * @throws LegacyAuthDisabledException if legacy endpoints are disabled
   */
  @Mutation(() => Boolean, { description: 'Logout user (from specific device)' })
  @Roles(RoleEnum.S_USER)
  @UseGuards(LegacyAuthRateLimitGuard)
  async logout(
    @CurrentUser() currentUser: ICoreAuthUser,
    @Context() ctx: { res: ResponseType },
    @Tokens('token') token: string,
    @Args('allDevices', { nullable: true }) allDevices?: boolean,
  ): Promise<boolean> {
    this.checkLegacyGraphQLEnabled('logout');
    const result = await this.authService.logout(token, { allDevices, currentUser });
    return this.processCookies(ctx, result);
  }

  /**
   * Refresh token (for specific device)
   *
   * @deprecated Will be replaced by BetterAuth session refresh in a future version
   * @throws LegacyAuthDisabledException if legacy endpoints are disabled
   */
  @Mutation(() => CoreAuthModel, { description: 'Refresh tokens (for specific device)' })
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(LegacyAuthRateLimitGuard, AuthGuard(AuthGuardStrategy.JWT_REFRESH))
  async refreshToken(
    @CurrentUser() user: ICoreAuthUser,
    @Tokens('refreshToken') refreshToken: string,
    @Context() ctx: { res: ResponseType },
  ): Promise<CoreAuthModel> {
    this.checkLegacyGraphQLEnabled('refreshToken');
    const result = await this.authService.refreshTokens(user, refreshToken);
    return this.processCookies(ctx, result);
  }

  /**
   * Sign in user via email and password (on specific device)
   *
   * @deprecated Will be replaced by BetterAuth signIn in a future version
   * @throws LegacyAuthDisabledException if legacy endpoints are disabled
   */
  @Mutation(() => CoreAuthModel, {
    description: 'Sign in user via email and password and get JWT tokens (for specific device)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(LegacyAuthRateLimitGuard)
  async signIn(
    @GraphQLServiceOptions({ gqlPath: 'signIn.user' }) serviceOptions: ServiceOptions,
    @Context() ctx: { res: ResponseType },
    @Args('input') input: CoreAuthSignInInput,
  ): Promise<CoreAuthModel> {
    this.checkLegacyGraphQLEnabled('signIn');
    const result = await this.authService.signIn(input, serviceOptions);
    return this.processCookies(ctx, result);
  }

  /**
   * Register a new user account (on specific device)
   *
   * @deprecated Will be replaced by BetterAuth signUp in a future version
   * @throws LegacyAuthDisabledException if legacy endpoints are disabled
   */
  @Mutation(() => CoreAuthModel, { description: 'Register a new user account (on specific device)' })
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(LegacyAuthRateLimitGuard)
  async signUp(
    @GraphQLServiceOptions({ gqlPath: 'signUp.user' }) serviceOptions: ServiceOptions,
    @Context() ctx: { res: ResponseType },
    @Args('input') input: CoreAuthSignUpInput,
  ): Promise<CoreAuthModel> {
    this.checkLegacyGraphQLEnabled('signUp');
    const result = await this.authService.signUp(input, serviceOptions);
    return this.processCookies(ctx, result);
  }

  // ===================================================================================================================
  // Helper
  // ===================================================================================================================

  /**
   * Process cookies — sets legacy auth cookies (token, refreshToken) with secure defaults
   * and optionally strips tokens from the response body per `cookies.exposeTokenInBody`.
   *
   * Delegates to the shared `setLegacyAuthCookies()` helper to ensure consistent
   * security options (httpOnly, sameSite=lax, secure in production) between the REST
   * controller and GraphQL resolver.
   */
  protected processCookies(ctx: { res: ResponseType }, result: any) {
    const cookiesConfig = this.configService.getFastButReadOnly<boolean | ICookiesConfig>('cookies');
    const env = this.configService.getFastButReadOnly<string>('env');
    return setLegacyAuthCookies(ctx.res, result, cookiesConfig, env);
  }
}
