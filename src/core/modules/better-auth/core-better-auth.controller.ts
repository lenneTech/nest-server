import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { isProduction, maskToken } from '../../common/helpers/logging.helper';
import { ConfigService } from '../../common/services/config.service';
import { BetterAuthSessionUser, BetterAuthUserMapper } from './better-auth-user.mapper';
import { sendWebResponse, toWebRequest } from './better-auth-web.helper';
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
 *
 * NOTE: The session token is NOT included in this response for security reasons.
 * It is set as an httpOnly cookie instead.
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

    // Try to sign in, with automatic legacy user migration
    return this.attemptSignIn(res, input, api, true);
  }

  /**
   * Attempt sign-in with optional legacy user migration
   * @param res - Response object
   * @param input - Sign-in credentials
   * @param api - Better-Auth API instance
   * @param allowMigration - Whether to attempt legacy migration on failure
   */
  private async attemptSignIn(
    res: Response,
    input: BetterAuthSignInInput,
    api: ReturnType<BetterAuthService['getApi']>,
    allowMigration: boolean,
  ): Promise<BetterAuthResponse> {
    // Normalize password to SHA256 format for consistency with Legacy Auth
    // This ensures users can sign in with either plain password or SHA256 hash
    const normalizedPassword = this.userMapper.normalizePasswordForIam(input.password);

    try {
      const response = await api!.signInEmail({
        body: { email: input.email, password: normalizedPassword },
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

      // If migration is allowed, try to migrate legacy user and retry
      if (allowMigration) {
        // Pass the original password for legacy verification, but migration uses normalized password
        const migrated = await this.userMapper.migrateAccountToIam(input.email, input.password);
        if (migrated) {
          this.logger.debug(`Migrated legacy user ${input.email} to IAM, retrying sign-in`);
          // Retry sign-in after migration (without allowing another migration to prevent loops)
          return this.attemptSignIn(res, input, api, false);
        }
      }

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

    // Normalize password to SHA256 format for consistency with Legacy Auth
    const normalizedPassword = this.userMapper.normalizePasswordForIam(input.password);

    try {
      const response = await api.signUpEmail({
        body: {
          email: input.email,
          name: input.name || input.email.split('@')[0],
          password: normalizedPassword,
        },
      });

      if (!response) {
        throw new BadRequestException('Sign-up failed');
      }

      if (hasUser(response)) {
        // Link or create user in our database
        await this.userMapper.linkOrCreateUser(response.user);

        // Sync password to legacy (enables IAM Sign-Up → Legacy Sign-In)
        // Pass the plain password so it can be hashed with bcrypt for Legacy Auth
        await this.userMapper.syncPasswordToLegacy(response.user.id, response.user.email, input.password);

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
   *
   * NOTE: The session token is intentionally NOT included in the response.
   * It is set as an httpOnly cookie for security.
   */
  protected mapSession(session: null | undefined | { expiresAt: Date; id: string; token?: string }): BetterAuthSessionInfo | undefined {
    if (!session) return undefined;
    return {
      expiresAt: session.expiresAt instanceof Date ? session.expiresAt.toISOString() : String(session.expiresAt),
      id: session.id,
      // NOTE: token is intentionally NOT returned - it's set as httpOnly cookie
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
   *
   * Sets multiple cookies for authentication compatibility:
   *
   * | Cookie Name | Purpose |
   * |-------------|---------|
   * | `token` | Primary session token (nest-server compatibility) |
   * | `{basePath}.session_token` | Better Auth's native cookie for plugins (e.g., `iam.session_token`) |
   * | `better-auth.session_token` | Legacy Better Auth cookie name (backwards compatibility) |
   * | `{configured}` | Custom cookie name if configured via `options.advanced.cookies.session_token.name` |
   * | `session` | Session ID for reference/debugging |
   *
   * IMPORTANT: Better Auth's sign-in returns a session token in `result.token`.
   * This is NOT a JWT - it's the session token stored in the database.
   * The JWT plugin generates JWTs separately via the /token endpoint when needed.
   *
   * For plugins like Passkey to work, the session token must be available in a cookie
   * that Better Auth's plugin system recognizes (default: `{basePath}.session_token`).
   *
   * @param res - Express Response object
   * @param result - The BetterAuthResponse to return
   * @param sessionToken - Optional session token to set in cookies (if not provided, uses result.token)
   */
  protected processCookies(res: Response, result: BetterAuthResponse, sessionToken?: string): BetterAuthResponse {
    // Check if cookie handling is activated
    if (this.configService.getFastButReadOnly('cookies')) {
      const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production' };

      // Use provided sessionToken or fall back to result.token
      const tokenToSet = sessionToken || result.token;

      if (tokenToSet) {
        // Set the primary token cookie (for nest-server compatibility)
        res.cookie('token', tokenToSet, cookieOptions);

        // Set Better Auth's native session token cookies for plugin compatibility
        // This is CRITICAL for Passkey/WebAuthn to work
        const basePath = this.betterAuthService.getBasePath().replace(/^\//, '').replace(/\//g, '.');
        const defaultCookieName = `${basePath}.session_token`;
        res.cookie(defaultCookieName, tokenToSet, cookieOptions);

        // Also set the legacy cookie name for backwards compatibility
        res.cookie('better-auth.session_token', tokenToSet, cookieOptions);

        // Get configured cookie name and set if different from defaults
        const betterAuthConfig = this.configService.getFastButReadOnly('betterAuth');
        const configuredCookieName = betterAuthConfig?.options?.advanced?.cookies?.session_token?.name;
        if (configuredCookieName && configuredCookieName !== 'token' && configuredCookieName !== defaultCookieName) {
          res.cookie(configuredCookieName, tokenToSet, cookieOptions);
        }

        // Remove token from response body (it's now in cookies)
        if (result.token) {
          delete result.token;
        }
      }

      // Set session ID cookie (for reference/debugging)
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

    // Clear the path-based session token cookie
    const basePath = this.betterAuthService.getBasePath().replace(/^\//, '').replace(/\//g, '.');
    const defaultCookieName = `${basePath}.session_token`;
    res.cookie(defaultCookieName, '', { ...cookieOptions, maxAge: 0 });

    // Clear configured session token cookie if different
    const betterAuthConfig = this.configService.getFastButReadOnly('betterAuth');
    const configuredCookieName = betterAuthConfig?.options?.advanced?.cookies?.session_token?.name;
    if (configuredCookieName && configuredCookieName !== 'token' && configuredCookieName !== defaultCookieName) {
      res.cookie(configuredCookieName, '', { ...cookieOptions, maxAge: 0 });
    }
  }

  // ===================================================================================================================
  // Better Auth Plugin Handler (shared implementation)
  // ===================================================================================================================

  /**
   * Handler for Better Auth plugin endpoints (Passkey, Social Login, etc.)
   *
   * This method forwards requests to Better Auth's native handler. It enables:
   * - Passkey/WebAuthn registration and authentication
   * - Social Login OAuth flows
   * - Email verification links
   * - Magic link authentication
   * - And other plugin-provided functionality
   *
   * IMPORTANT: This method injects the session token into both cookies AND
   * Authorization header to ensure Better Auth can find the session via
   * multiple lookup strategies.
   */
  @ApiExcludeEndpoint() // Don't show in Swagger docs
  protected async handleBetterAuthPlugins(req: Request, res: Response): Promise<void> {
    this.ensureEnabled();

    const authInstance = this.betterAuthService.getInstance();
    if (!authInstance) {
      throw new InternalServerErrorException('Better-Auth not initialized');
    }

    if (!isProduction()) {
      this.logger.debug(`Forwarding to Better Auth: ${req.method} ${req.path}`);
    }

    try {
      // Extract session token from the validated middleware session or cookies
      const sessionToken = this.getSessionTokenFromRequest(req);

      if (!isProduction()) {
        this.logger.debug(`Session token for forwarding: ${maskToken(sessionToken)}`);
      }

      // Get config for signing cookies
      const config = this.betterAuthService.getConfig();

      // Convert Express request to Web Standard Request with enhanced session context
      const webRequest = await toWebRequest(req, {
        basePath: this.betterAuthService.getBasePath(),
        baseUrl: this.betterAuthService.getBaseUrl(),
        logger: this.logger,
        secret: config.secret,
        sessionToken,
      });

      // Call Better Auth's native handler
      const response = await authInstance.handler(webRequest);

      if (!isProduction()) {
        this.logger.debug(`Better Auth handler response status: ${response.status}`);
      }

      // Send the response back
      await sendWebResponse(res, response);
    } catch (error) {
      this.logger.error(`Better Auth handler error: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Re-throw NestJS exceptions
      if (error instanceof BadRequestException || error instanceof UnauthorizedException || error instanceof InternalServerErrorException) {
        throw error;
      }

      throw new InternalServerErrorException('Authentication handler error');
    }
  }

  /**
   * Gets the session token from the request.
   * Prioritizes the middleware-validated session, then falls back to cookies.
   */
  private getSessionTokenFromRequest(req: Request): null | string {
    // First, try to get token from middleware-validated session
    const betterAuthReq = req as any;
    if (betterAuthReq.betterAuthSession?.session?.token) {
      return betterAuthReq.betterAuthSession.session.token;
    }

    // Fall back to extracting from cookies
    return this.extractSessionToken(req);
  }
}
