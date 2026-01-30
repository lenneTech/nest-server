import { Body, Controller, Get, ParseBoolPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Response as ResponseType } from 'express';

import { ApiCommonErrorResponses } from '../../common/decorators/common-error.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
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
 * Authentication controller for REST endpoints
 *
 * This controller provides Legacy Auth endpoints via REST.
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
 *     rest: false     // Disable only REST endpoints
 *   }
 * }
 * ```
 *
 * @see https://github.com/lenneTech/nest-server/blob/develop/.claude/rules/module-deprecation.md
 */
@ApiCommonErrorResponses()
@Controller('auth')
@Roles(RoleEnum.ADMIN)
export class CoreAuthController {
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
   * Check if legacy REST endpoints are enabled
   *
   * Throws LegacyAuthDisabledException if:
   * - config.auth.legacyEndpoints.enabled is false
   * - config.auth.legacyEndpoints.rest is false
   *
   * @throws LegacyAuthDisabledException
   */
  protected checkLegacyRESTEnabled(endpointName: string): void {
    const authConfig = this.configService.getFastButReadOnly('auth');
    const legacyConfig = authConfig?.legacyEndpoints;

    // Check if legacy endpoints are globally disabled
    if (legacyConfig?.enabled === false) {
      throw new LegacyAuthDisabledException(endpointName);
    }

    // Check if REST endpoints specifically are disabled
    if (legacyConfig?.rest === false) {
      throw new LegacyAuthDisabledException(endpointName);
    }
  }

  /**
   * Logout user (from specific device)
   *
   * @deprecated Will be replaced by BetterAuth signOut in a future version
   * @throws LegacyAuthDisabledException if legacy endpoints are disabled
   */
  @ApiGoneResponse({ description: 'Legacy Auth endpoints are disabled' })
  @ApiOkResponse({ type: Boolean })
  @ApiOperation({ description: 'Logs a user out from a specific device' })
  @ApiQuery({ description: 'If all devices should be logged out,', name: 'allDevices', required: false, type: Boolean })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @Get('logout')
  @Roles(RoleEnum.S_USER)
  @UseGuards(LegacyAuthRateLimitGuard)
  async logout(
    @CurrentUser() currentUser: ICoreAuthUser,
    @Tokens('token') token: string,
    @Res({ passthrough: true }) res: ResponseType,
    @Query('allDevices', new ParseBoolPipe({ optional: true })) allDevices?: boolean,
  ): Promise<boolean> {
    this.checkLegacyRESTEnabled('logout');
    const result = await this.authService.logout(token, { allDevices, currentUser });
    return this.processCookies(res, result);
  }

  /**
   * Refresh token (for specific device)
   *
   * @deprecated Will be replaced by BetterAuth session refresh in a future version
   * @throws LegacyAuthDisabledException if legacy endpoints are disabled
   */
  @ApiGoneResponse({ description: 'Legacy Auth endpoints are disabled' })
  @ApiOkResponse({ type: CoreAuthModel })
  @ApiOperation({ description: 'Refresh token (for specific device)' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @Get('refresh-token')
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(LegacyAuthRateLimitGuard, AuthGuard(AuthGuardStrategy.JWT_REFRESH))
  async refreshToken(
    @CurrentUser() user: ICoreAuthUser,
    @Tokens('refreshToken') refreshToken: string,
    @Res({ passthrough: true }) res: ResponseType,
  ): Promise<CoreAuthModel> {
    this.checkLegacyRESTEnabled('refresh-token');
    const result = await this.authService.refreshTokens(user, refreshToken);
    return this.processCookies(res, result);
  }

  /**
   * Sign in user via email and password (on specific device)
   *
   * @deprecated Will be replaced by BetterAuth signIn in a future version
   * @throws LegacyAuthDisabledException if legacy endpoints are disabled
   */
  @ApiCreatedResponse({ description: 'Signed in successfully', type: CoreAuthModel })
  @ApiGoneResponse({ description: 'Legacy Auth endpoints are disabled' })
  @ApiOperation({ description: 'Sign in via email and password' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @Post('signin')
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(LegacyAuthRateLimitGuard)
  async signIn(
    @Res({ passthrough: true }) res: ResponseType,
    @Body() input: CoreAuthSignInInput,
  ): Promise<CoreAuthModel> {
    this.checkLegacyRESTEnabled('signin');
    const result = await this.authService.signIn(input);
    return this.processCookies(res, result);
  }

  /**
   * Register a new user account (on specific device)
   *
   * @deprecated Will be replaced by BetterAuth signUp in a future version
   * @throws LegacyAuthDisabledException if legacy endpoints are disabled
   */
  @ApiBody({ type: CoreAuthSignUpInput })
  @ApiCreatedResponse({ type: CoreAuthSignUpInput })
  @ApiGoneResponse({ description: 'Legacy Auth endpoints are disabled' })
  @ApiOperation({ description: 'Sign up via email and password' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @Post('signup')
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(LegacyAuthRateLimitGuard)
  async signUp(
    @Res({ passthrough: true }) res: ResponseType,
    @Body() input: CoreAuthSignUpInput,
  ): Promise<CoreAuthModel> {
    this.checkLegacyRESTEnabled('signup');
    const result = await this.authService.signUp(input);
    return this.processCookies(res, result);
  }

  // ===================================================================================================================
  // Helper
  // ===================================================================================================================

  /**
   * Process cookies
   */
  protected processCookies(res: ResponseType, result: any) {
    // Check if cookie handling is activated (enabled by default, unless explicitly set to false)
    if (this.configService.getFastButReadOnly('cookies') !== false) {
      // Set cookies
      if (!result || typeof result !== 'object') {
        res.cookie('token', '', { httpOnly: true });
        res.cookie('refreshToken', '', { httpOnly: true });
        return result;
      }
      res.cookie('token', result?.token || '', { httpOnly: true });
      res.cookie('refreshToken', result?.refreshToken || '', { httpOnly: true });

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
