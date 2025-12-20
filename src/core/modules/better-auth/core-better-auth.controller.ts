import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { BetterAuthSessionUser, BetterAuthUserMapper } from './better-auth-user.mapper';
import { BetterAuthService } from './better-auth.service';
import { hasSession, hasUser, requires2FA } from './better-auth.types';

// ===================================================================================================================
// Response Models
// ===================================================================================================================

/**
 * Token response interface for JWT tokens
 */
interface TokenResponse {
  token?: string;
}

/**
 * Session info for REST responses
 */
export class BetterAuthSessionInfo {
  @ApiProperty({ description: 'Session expiration time' })
  expiresAt: string;

  @ApiProperty({ description: 'Session ID' })
  id: string;
}

/**
 * User model for REST responses
 */
export class BetterAuthUserResponse {
  @ApiProperty({ description: 'User email address' })
  email: string;

  @ApiProperty({ description: 'Whether email is verified' })
  emailVerified: boolean;

  @ApiProperty({ description: 'User ID from Better-Auth' })
  id: string;

  @ApiProperty({ description: 'User display name' })
  name: string;

  @ApiProperty({ description: 'Whether 2FA is enabled', required: false })
  twoFactorEnabled?: boolean;
}

/**
 * Standard auth response
 */
export class BetterAuthResponse {
  @ApiProperty({ description: 'Error message if failed', required: false })
  error?: string;

  @ApiProperty({ description: 'Whether 2FA is required', required: false })
  requiresTwoFactor?: boolean;

  @ApiProperty({ description: 'Session information', required: false, type: BetterAuthSessionInfo })
  session?: BetterAuthSessionInfo;

  @ApiProperty({ description: 'Whether operation succeeded' })
  success: boolean;

  @ApiProperty({ description: 'JWT token (if JWT plugin enabled)', required: false })
  token?: string;

  @ApiProperty({ description: 'User information', required: false, type: BetterAuthUserResponse })
  user?: BetterAuthUserResponse;
}

// ===================================================================================================================
// Type Guards
// ===================================================================================================================

/**
 * Sign-in input DTO
 */
export class BetterAuthSignInInput {
  @ApiProperty({ description: 'User email address', example: 'user@example.com' })
  email: string;

  @ApiProperty({ description: 'User password' })
  password: string;
}

/**
 * Sign-up input DTO
 */
export class BetterAuthSignUpInput {
  @ApiProperty({ description: 'User email address', example: 'user@example.com' })
  email: string;

  @ApiProperty({ description: 'Display name', example: 'John Doe', required: false })
  name?: string;

  @ApiProperty({ description: 'User password (min 8 characters)' })
  password: string;
}

/**
 * 2FA verification input DTO
 */
export class BetterAuthTwoFactorInput {
  @ApiProperty({ description: 'TOTP code from authenticator app', example: '123456' })
  code: string;
}

/**
 * 2FA setup response
 */
export class BetterAuthTwoFactorSetupResponse {
  @ApiProperty({ description: 'Backup codes for recovery' })
  backupCodes: string[];

  @ApiProperty({ description: 'Whether operation succeeded' })
  success: boolean;

  @ApiProperty({ description: 'TOTP secret for manual entry' })
  totpSecret: string;

  @ApiProperty({ description: 'QR code URI for authenticator apps' })
  totpUri: string;
}

// ===================================================================================================================
// Controller
// ===================================================================================================================

/**
 * Core Better-Auth REST Controller
 *
 * Provides REST endpoints for Better-Auth authentication operations.
 * This controller follows the same pattern as CoreAuthController and can be
 * extended by project-specific implementations.
 *
 * @example
 * ```typescript
 * // In your project - src/server/modules/better-auth/better-auth.controller.ts
 * @Controller('iam')
 * export class BetterAuthController extends CoreBetterAuthController {
 *   constructor(
 *     betterAuthService: BetterAuthService,
 *     userMapper: BetterAuthUserMapper,
 *     configService: ConfigService,
 *     private readonly emailService: EmailService,
 *   ) {
 *     super(betterAuthService, userMapper, configService);
 *   }
 *
 *   override async signUp(res: Response, input: BetterAuthSignUpInput) {
 *     const result = await super.signUp(res, input);
 *     if (result.success && result.user) {
 *       await this.emailService.sendWelcomeEmail(result.user.email);
 *     }
 *     return result;
 *   }
 * }
 * ```
 */
@ApiTags('Better-Auth')
@Controller('iam')
@Roles(RoleEnum.ADMIN)
export class CoreBetterAuthController {
  protected readonly logger = new Logger(CoreBetterAuthController.name);

  constructor(
    protected readonly betterAuthService: BetterAuthService,
    protected readonly userMapper: BetterAuthUserMapper,
    protected readonly configService: ConfigService,
  ) {}

  // ===================================================================================================================
  // Authentication Endpoints
  // ===================================================================================================================

  /**
   * Sign in with email and password
   */
  @ApiBody({ type: BetterAuthSignInInput })
  @ApiCreatedResponse({ description: 'Signed in successfully', type: BetterAuthResponse })
  @ApiOperation({ description: 'Sign in via Better-Auth with email and password', summary: 'Sign In' })
  @HttpCode(HttpStatus.OK)
  @Post('sign-in/email')
  @Roles(RoleEnum.S_EVERYONE)
  async signIn(
    @Res({ passthrough: true }) res: Response,
    @Body() input: BetterAuthSignInInput,
  ): Promise<BetterAuthResponse> {
    this.ensureEnabled();

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException('Better-Auth API not available');
    }

    try {
      const response = await api.signInEmail({
        body: { email: input.email, password: input.password },
      });

      if (!response) {
        throw new UnauthorizedException('Invalid credentials');
      }

      // Check for 2FA requirement
      if (requires2FA(response)) {
        return { requiresTwoFactor: true, success: false };
      }

      // Get user data
      if (hasUser(response)) {
        const mappedUser = await this.userMapper.mapSessionUser(response.user);
        const token = this.betterAuthService.isJwtEnabled() ? (response as TokenResponse).token : undefined;

        const result: BetterAuthResponse = {
          requiresTwoFactor: false,
          session: hasSession(response) ? this.mapSession(response.session) : undefined,
          success: true,
          token,
          user: mappedUser ? this.mapUser(response.user, mappedUser) : undefined,
        };

        return this.processCookies(res, result);
      }

      throw new UnauthorizedException('Invalid credentials');
    } catch (error) {
      this.logger.debug(`Sign-in error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  /**
   * Sign up with email and password
   */
  @ApiBody({ type: BetterAuthSignUpInput })
  @ApiCreatedResponse({ description: 'Signed up successfully', type: BetterAuthResponse })
  @ApiOperation({ description: 'Sign up via Better-Auth with email and password', summary: 'Sign Up' })
  @Post('sign-up/email')
  @Roles(RoleEnum.S_EVERYONE)
  async signUp(
    @Res({ passthrough: true }) res: Response,
    @Body() input: BetterAuthSignUpInput,
  ): Promise<BetterAuthResponse> {
    this.ensureEnabled();

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException('Better-Auth API not available');
    }

    try {
      const response = await api.signUpEmail({
        body: {
          email: input.email,
          name: input.name || input.email.split('@')[0],
          password: input.password,
        },
      });

      if (!response) {
        throw new BadRequestException('Sign-up failed');
      }

      if (hasUser(response)) {
        // Link or create user in our database
        await this.userMapper.linkOrCreateUser(response.user);
        const mappedUser = await this.userMapper.mapSessionUser(response.user);

        const result: BetterAuthResponse = {
          requiresTwoFactor: false,
          session: hasSession(response) ? this.mapSession(response.session) : undefined,
          success: true,
          user: mappedUser ? this.mapUser(response.user, mappedUser) : undefined,
        };

        return this.processCookies(res, result);
      }

      throw new BadRequestException('Sign-up failed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`Sign-up error: ${errorMessage}`);
      if (errorMessage.includes('already exists')) {
        throw new BadRequestException('User with this email already exists');
      }
      throw new BadRequestException('Sign-up failed');
    }
  }

  /**
   * Sign out (logout)
   */
  @ApiOkResponse({ description: 'Signed out successfully', type: BetterAuthResponse })
  @ApiOperation({ description: 'Sign out from Better-Auth', summary: 'Sign Out' })
  @Get('sign-out')
  @Roles(RoleEnum.S_EVERYONE)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<BetterAuthResponse> {
    if (!this.betterAuthService.isEnabled()) {
      return { success: true };
    }

    try {
      // Get session token from cookies or authorization header
      const sessionToken = this.extractSessionToken(req);

      if (sessionToken) {
        await this.betterAuthService.revokeSession(sessionToken);
      }

      // Clear cookies
      this.clearAuthCookies(res);

      return { success: true };
    } catch (error) {
      this.logger.debug(`Sign-out error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Still return success - user is logged out from our perspective
      this.clearAuthCookies(res);
      return { success: true };
    }
  }

  /**
   * Get current session
   */
  @ApiOkResponse({ description: 'Current session', type: BetterAuthResponse })
  @ApiOperation({ description: 'Get current session from Better-Auth', summary: 'Get Session' })
  @Get('session')
  @Roles(RoleEnum.S_EVERYONE)
  async getSession(@Req() req: Request): Promise<BetterAuthResponse> {
    if (!this.betterAuthService.isEnabled()) {
      return { error: 'Better-Auth is disabled', success: false };
    }

    try {
      const { session, user } = await this.betterAuthService.getSession(req);

      if (!session || !user) {
        return { success: false };
      }

      const mappedUser = await this.userMapper.mapSessionUser(user);

      return {
        session: this.mapSession(session),
        success: true,
        user: mappedUser ? this.mapUser(user, mappedUser) : undefined,
      };
    } catch (error) {
      this.logger.debug(`Get session error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false };
    }
  }

  // ===================================================================================================================
  // Two-Factor Authentication Endpoints
  // ===================================================================================================================

  /**
   * Enable 2FA for current user
   */
  @ApiOkResponse({ description: '2FA setup information', type: BetterAuthTwoFactorSetupResponse })
  @ApiOperation({ description: 'Enable Two-Factor Authentication', summary: 'Enable 2FA' })
  @Post('two-factor/enable')
  @Roles(RoleEnum.S_USER)
  async enableTwoFactor(@Req() req: Request): Promise<BetterAuthResponse | BetterAuthTwoFactorSetupResponse> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    const api = this.betterAuthService.getApi();
    if (!api || !('enableTwoFactor' in api)) {
      throw new BadRequestException('2FA API not available');
    }

    try {
      const headers = this.extractHeaders(req);
      const response = await (api as any).enableTwoFactor({ headers });

      if (!response) {
        throw new BadRequestException('Failed to enable 2FA');
      }

      return {
        backupCodes: response.backupCodes || [],
        success: true,
        totpSecret: response.totpSecret || '',
        totpUri: response.totpURI || '',
      };
    } catch (error) {
      this.logger.debug(`Enable 2FA error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new BadRequestException('Failed to enable 2FA');
    }
  }

  /**
   * Verify 2FA code during sign-in
   */
  @ApiBody({ type: BetterAuthTwoFactorInput })
  @ApiOkResponse({ description: 'Verification result', type: BetterAuthResponse })
  @ApiOperation({ description: 'Verify Two-Factor Authentication code', summary: 'Verify 2FA' })
  @HttpCode(HttpStatus.OK)
  @Post('two-factor/verify')
  @Roles(RoleEnum.S_EVERYONE)
  async verifyTwoFactor(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() input: BetterAuthTwoFactorInput,
  ): Promise<BetterAuthResponse> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    const api = this.betterAuthService.getApi();
    if (!api || !('verifyTOTP' in api)) {
      throw new BadRequestException('2FA API not available');
    }

    try {
      const headers = this.extractHeaders(req);
      const response = await (api as any).verifyTOTP({
        body: { code: input.code },
        headers,
      });

      if (!response) {
        throw new UnauthorizedException('Invalid 2FA code');
      }

      if (hasUser(response)) {
        const mappedUser = await this.userMapper.mapSessionUser(response.user);
        const token = this.betterAuthService.isJwtEnabled() ? (response as TokenResponse).token : undefined;

        const result: BetterAuthResponse = {
          session: hasSession(response) ? this.mapSession(response.session) : undefined,
          success: true,
          token,
          user: mappedUser ? this.mapUser(response.user, mappedUser) : undefined,
        };

        return this.processCookies(res, result);
      }

      throw new UnauthorizedException('Invalid 2FA code');
    } catch (error) {
      this.logger.debug(`Verify 2FA error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new UnauthorizedException('Invalid 2FA code');
    }
  }

  /**
   * Disable 2FA for current user
   */
  @ApiOkResponse({ description: 'Disable result', type: BetterAuthResponse })
  @ApiOperation({ description: 'Disable Two-Factor Authentication', summary: 'Disable 2FA' })
  @Post('two-factor/disable')
  @Roles(RoleEnum.S_USER)
  async disableTwoFactor(@Req() req: Request): Promise<BetterAuthResponse> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    const api = this.betterAuthService.getApi();
    if (!api || !('disableTwoFactor' in api)) {
      throw new BadRequestException('2FA API not available');
    }

    try {
      const headers = this.extractHeaders(req);
      await (api as any).disableTwoFactor({ headers });

      return { success: true };
    } catch (error) {
      this.logger.debug(`Disable 2FA error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new BadRequestException('Failed to disable 2FA');
    }
  }

  // ===================================================================================================================
  // Helper Methods (protected for extension)
  // ===================================================================================================================

  /**
   * Ensure Better-Auth is enabled
   */
  protected ensureEnabled(): void {
    if (!this.betterAuthService.isEnabled()) {
      throw new BadRequestException('Better-Auth is not enabled');
    }
  }

  /**
   * Extract session token from request
   */
  protected extractSessionToken(req: Request): null | string {
    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // Check cookies
    const basePath = this.betterAuthService.getBasePath().replace(/^\//, '').replace(/\//g, '.');
    const cookieName = `${basePath}.session_token`;
    return req.cookies?.[cookieName] || req.cookies?.['better-auth.session_token'] || null;
  }

  /**
   * Extract headers for Better-Auth API calls
   */
  protected extractHeaders(req: Request): Headers {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        headers.set(key, value.join(', '));
      }
    }
    return headers;
  }

  /**
   * Map session to response format
   */
  protected mapSession(session: null | undefined | { expiresAt: Date; id: string }): BetterAuthSessionInfo | undefined {
    if (!session) return undefined;
    return {
      expiresAt: session.expiresAt instanceof Date ? session.expiresAt.toISOString() : String(session.expiresAt),
      id: session.id,
    };
  }

  /**
   * Map user to response format
   * @param sessionUser - The user from Better-Auth session
   * @param _mappedUser - The synced user from legacy system (available for override customization)
   */
  // eslint-disable-next-line unused-imports/no-unused-vars
  protected mapUser(sessionUser: BetterAuthSessionUser, _mappedUser: any): BetterAuthUserResponse {
    return {
      email: sessionUser.email,
      emailVerified: sessionUser.emailVerified || false,
      id: sessionUser.id,
      name: sessionUser.name || sessionUser.email.split('@')[0],
    };
  }

  /**
   * Process cookies for response
   */
  protected processCookies(res: Response, result: BetterAuthResponse): BetterAuthResponse {
    // Check if cookie handling is activated
    if (this.configService.getFastButReadOnly('cookies')) {
      const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production' };

      // Set or clear token cookie
      if (result.token) {
        res.cookie('token', result.token, cookieOptions);
        delete result.token; // Remove from response body
      }

      // Set session cookie if we have a session
      if (result.session) {
        res.cookie('session', result.session.id, cookieOptions);
      }
    }

    return result;
  }

  /**
   * Clear authentication cookies
   */
  protected clearAuthCookies(res: Response): void {
    const cookieOptions = { httpOnly: true, sameSite: 'lax' as const };
    res.cookie('token', '', { ...cookieOptions, maxAge: 0 });
    res.cookie('session', '', { ...cookieOptions, maxAge: 0 });
    res.cookie('better-auth.session_token', '', { ...cookieOptions, maxAge: 0 });
  }
}
