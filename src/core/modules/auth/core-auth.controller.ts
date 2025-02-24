import { Body, Controller, Get, ParseBoolPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Response as ResponseType } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { AuthGuardStrategy } from './auth-guard-strategy.enum';
import { CoreAuthModel } from './core-auth.model';
import { AuthGuard } from './guards/auth.guard';
import { CoreAuthSignInInput } from './inputs/core-auth-sign-in.input';
import { CoreAuthSignUpInput } from './inputs/core-auth-sign-up.input';
import { ICoreAuthUser } from './interfaces/core-auth-user.interface';
import { CoreAuthService } from './services/core-auth.service';
import { Tokens } from './tokens.decorator';

@Roles(RoleEnum.ADMIN)
@Controller('auth')
export class CoreAuthController {
  /**
   * Import services
   */
  constructor(
    protected readonly authService: CoreAuthService,
    protected readonly configService: ConfigService,
  ) {}

  /**
   * Logout user (from specific device)
   */
  @ApiOperation({ description: 'Logs a user out from a specific device' })
  @Get('logout')
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  async logout(
    @CurrentUser() currentUser: ICoreAuthUser,
    @Tokens('token') token: string,
    @Res({ passthrough: true }) res: ResponseType,
    @Query('allDevices', ParseBoolPipe) allDevices?: boolean,
  ): Promise<boolean> {
    const result = await this.authService.logout(token, { allDevices, currentUser });
    return this.processCookies(res, result);
  }

  /**
   * Refresh token (for specific device)
   */
  @ApiResponse({ type: CoreAuthModel })
  @Get('refresh-token')
  @Roles(RoleEnum.S_EVERYONE)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT_REFRESH))
  async refreshToken(
    @CurrentUser() user: ICoreAuthUser,
    @Tokens('refreshToken') refreshToken: string,
    @Res({ passthrough: true }) res: ResponseType,
  ): Promise<CoreAuthModel> {
    const result = await this.authService.refreshTokens(user, refreshToken);
    return this.processCookies(res, result);
  }

  /**
   * Sign in user via email and password (on specific device)
   */
  @ApiOperation({ description: 'Sign in via email and password' })
  @Post('signin')
  @Roles(RoleEnum.S_EVERYONE)
  async signIn(@Res({ passthrough: true }) res: ResponseType, @Body() input: CoreAuthSignInInput): Promise<CoreAuthModel> {
    const result = await this.authService.signIn(input);
    return this.processCookies(res, result);
  }

  /**
   * Register a new user account (on specific device)
   */
  @ApiBody({ type: CoreAuthSignUpInput })
  @ApiOperation({ description: 'Sign up via email and password' })
  @Post('signup')
  @Roles(RoleEnum.S_EVERYONE)
  async signUp(@Res() res: ResponseType, @Body() input: CoreAuthSignUpInput): Promise<CoreAuthModel> {
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
    // Check if cookie handling is activated
    if (this.configService.getFastButReadOnly('cookies')) {
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
