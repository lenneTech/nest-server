import { Body, Controller, Get, Param, ParseBoolPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Args } from '@nestjs/graphql';
import { Response as ResponseType } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ConfigService } from '../../common/services/config.service';
import { AuthGuardStrategy } from './auth-guard-strategy.enum';
import { CoreAuthModel } from './core-auth.model';
import { AuthGuard } from './guards/auth.guard';
import { CoreAuthSignInInput } from './inputs/core-auth-sign-in.input';
import { CoreAuthSignUpInput } from './inputs/core-auth-sign-up.input';
import { ICoreAuthUser } from './interfaces/core-auth-user.interface';
import { CoreAuthService } from './services/core-auth.service';
import { Tokens } from './tokens.decorator';

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
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  @Get()
  async logout(
    @CurrentUser() currentUser: ICoreAuthUser,
    @Tokens('token') token: string,
    @Res() res: ResponseType,
    @Param('allDevices', ParseBoolPipe) allDevices?: boolean,
  ): Promise<boolean> {
    const result = await this.authService.logout(token, { allDevices, currentUser });
    return this.processCookies(res, result);
  }

  /**
   * Refresh token (for specific device)
   */
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT_REFRESH))
  @Get()
  async refreshToken(
    @CurrentUser() user: ICoreAuthUser,
    @Tokens('refreshToken') refreshToken: string,
    @Res() res: ResponseType,
  ): Promise<CoreAuthModel> {
    const result = await this.authService.refreshTokens(user, refreshToken);
    return this.processCookies(res, result);
  }

  /**
   * Sign in user via email and password (on specific device)
   */
  @Post()
  async signIn(@Res() res: ResponseType, @Body('input') input: CoreAuthSignInInput): Promise<CoreAuthModel> {
    const result = await this.authService.signIn(input);
    return this.processCookies(res, result);
  }

  /**
   * Register a new user account (on specific device)
   */
  @Post()
  async signUp(@Res() res: ResponseType, @Args('input') input: CoreAuthSignUpInput): Promise<CoreAuthModel> {
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
