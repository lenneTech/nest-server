import { Body, Controller, Get, Param, ParseBoolPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Args, Info } from '@nestjs/graphql';
import { Response as ResponseType } from 'express';
import { GraphQLResolveInfo } from 'graphql/index';
import { GraphQLUser } from '../../common/decorators/graphql-user.decorator';
import { RESTUser } from '../../common/decorators/rest-user.decorator';
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
  constructor(protected readonly authService: CoreAuthService, protected readonly configService: ConfigService) {}

  /**
   * Logout user (from specific device)
   */
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  @Get()
  async logout(
    @RESTUser() currentUser: ICoreAuthUser,
    @Tokens('token') token: string,
    @Res() res: ResponseType,
    @Param('allDevices', ParseBoolPipe) allDevices?: boolean
  ): Promise<boolean> {
    const result = await this.authService.logout(token, { currentUser, allDevices });
    return this.processCookies(res, result);
  }

  /**
   * Refresh token (for specific device)
   */
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT_REFRESH))
  @Get()
  async refreshToken(
    @GraphQLUser() user: ICoreAuthUser,
    @Tokens('refreshToken') refreshToken: string,
    @Res() res: ResponseType
  ): Promise<CoreAuthModel> {
    const result = await this.authService.refreshTokens(user, refreshToken);
    return this.processCookies(res, result);
  }

  /**
   * Sign in user via email and password (on specific device)
   */
  @Post()
  async signIn(
    @Info() info: GraphQLResolveInfo,
    @Res() res: ResponseType,
    @Body('input') input: CoreAuthSignInInput
  ): Promise<CoreAuthModel> {
    const result = await this.authService.signIn(input);
    return this.processCookies(res, result);
  }

  /**
   * Register a new user account (on specific device)
   */
  @Post()
  async signUp(
    @Info() info: GraphQLResolveInfo,
    @Res() res: ResponseType,
    @Args('input') input: CoreAuthSignUpInput
  ): Promise<CoreAuthModel> {
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
      if (typeof result !== 'object') {
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
