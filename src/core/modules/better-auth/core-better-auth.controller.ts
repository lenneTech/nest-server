import {
  All,
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Optional,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { maskEmail, maskToken } from '../../common/helpers/logging.helper';
import { ConfigService } from '../../common/services/config.service';
import { ErrorCode } from '../error-code/error-codes';
import { BetterAuthSignInResponse, hasSession, hasUser, requires2FA } from './better-auth.types';
import { BetterAuthCookieHelper, createCookieHelper } from './core-better-auth-cookie.helper';
import { CoreBetterAuthEmailVerificationService } from './core-better-auth-email-verification.service';
import { CoreBetterAuthSignUpValidatorService } from './core-better-auth-signup-validator.service';
import { isSessionToken } from './core-better-auth-token.helper';
import { BetterAuthSessionUser, CoreBetterAuthUserMapper } from './core-better-auth-user.mapper';
import { convertExpressHeaders, sendWebResponse, toWebRequest } from './core-better-auth-web.helper';
import { CoreBetterAuthService } from './core-better-auth.service';

// ===================================================================================================================
// Response Models
// ===================================================================================================================

/**
 * Session info for REST responses
 *
 * NOTE: The session token is NOT included in this response for security reasons.
 * It is set as an httpOnly cookie instead.
 */
export class CoreBetterAuthSessionInfo {
  @ApiProperty({ description: 'Session expiration time' })
  expiresAt: string;

  @ApiProperty({ description: 'Session ID' })
  id: string;
}

/**
 * User model for REST responses
 */
export class CoreBetterAuthUserResponse {
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
export class CoreBetterAuthResponse {
  @ApiProperty({ description: 'Whether email verification is required before login', required: false })
  emailVerificationRequired?: boolean;

  @ApiProperty({ description: 'Error message if failed', required: false })
  error?: string;

  @ApiProperty({ description: 'Whether 2FA is required', required: false })
  requiresTwoFactor?: boolean;

  @ApiProperty({ description: 'Session information', required: false, type: CoreBetterAuthSessionInfo })
  session?: CoreBetterAuthSessionInfo;

  @ApiProperty({ description: 'Whether operation succeeded' })
  success: boolean;

  @ApiProperty({ description: 'JWT token (if JWT plugin enabled)', required: false })
  token?: string;

  @ApiProperty({ description: 'User information', required: false, type: CoreBetterAuthUserResponse })
  user?: CoreBetterAuthUserResponse;
}

// ===================================================================================================================
// Type Guards
// ===================================================================================================================

/**
 * Sign-in input DTO
 */
export class CoreBetterAuthSignInInput {
  @ApiProperty({ description: 'User email address', example: 'user@example.com' })
  email: string;

  @ApiProperty({ description: 'User password' })
  password: string;
}

/**
 * Sign-up input DTO
 */
export class CoreBetterAuthSignUpInput {
  @ApiProperty({ description: 'User email address', example: 'user@example.com' })
  email: string;

  @ApiProperty({ description: 'Display name', example: 'John Doe', required: false })
  name?: string;

  @ApiProperty({ description: 'User password (min 8 characters)' })
  password: string;

  @ApiProperty({ description: 'Whether user accepted terms and privacy policy', required: false })
  termsAndPrivacyAccepted?: boolean;
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
 * ## Why Custom Controller Instead of Native Better-Auth Endpoints?
 *
 * This controller implements custom endpoints rather than directly using Better-Auth's
 * native API. This architecture is **necessary** for nest-server's requirements:
 *
 * ### 1. Better-Auth Hooks Cannot:
 * - Access plaintext passwords in after-hooks (needed for Legacy sync)
 * - Modify HTTP responses (needed for custom response format)
 * - Set cookies (needed for multi-cookie auth strategy)
 * - Access NestJS Dependency Injection (needed for UserService, etc.)
 *
 * ### 2. Custom Endpoints Enable:
 * - **Hybrid Auth**: Bidirectional Legacy Auth ↔ Better-Auth synchronization
 * - **Password Normalization**: SHA256 pre-hashing for security
 * - **Legacy Migration**: Automatic migration of legacy users on sign-in
 * - **Multi-Cookie Support**: Setting multiple auth cookies for compatibility
 * - **Role Mapping**: Integration with nest-server's role-based access control
 *
 * ### 3. Native Handler Where Possible:
 * Despite custom endpoints, we use `authInstance.handler()` for:
 * - Plugin routes (Passkey, 2FA, OAuth)
 * - 2FA verification (for correct cookie handling)
 * - All plugin-provided functionality
 *
 * See README.md section "Architecture: Why Custom Controllers?" for details.
 *
 * @example
 * ```typescript
 * // In your project - src/server/modules/better-auth/better-auth.controller.ts
 * @Controller('iam')
 * export class BetterAuthController extends CoreBetterAuthController {
 *   constructor(
 *     betterAuthService: CoreBetterAuthService,
 *     userMapper: CoreBetterAuthUserMapper,
 *     configService: ConfigService,
 *     private readonly emailService: EmailService,
 *   ) {
 *     super(betterAuthService, userMapper, configService);
 *   }
 *
 *   override async signUp(res: Response, input: CoreBetterAuthSignUpInput) {
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
  protected readonly cookieHelper: BetterAuthCookieHelper;

  constructor(
    protected readonly betterAuthService: CoreBetterAuthService,
    protected readonly userMapper: CoreBetterAuthUserMapper,
    protected readonly configService: ConfigService,
    @Optional() protected readonly signUpValidator?: CoreBetterAuthSignUpValidatorService,
    @Optional() protected readonly emailVerificationService?: CoreBetterAuthEmailVerificationService,
  ) {
    // Detect if Legacy Auth is active (for < 11.7.0 compatibility)
    // Legacy Auth is active when JWT secret is configured
    const jwtConfig = this.configService.getFastButReadOnly('jwt');
    const legacyAuthEnabled = !!(jwtConfig?.secret || jwtConfig?.secretOrPrivateKey);

    // Get Better-Auth secret for cookie signing
    // CRITICAL: Cookies must be signed for Passkey/2FA to work
    const betterAuthConfig = this.betterAuthService.getConfig();

    // Read crossSubDomainCookies domain from Better Auth options
    // This enables cookie sharing across subdomains (e.g., api.example.com → ws.example.com)
    const crossSubDomainDomain = (betterAuthConfig?.options as any)?.advanced?.crossSubDomainCookies?.domain;

    // Initialize cookie helper with Legacy Auth detection, secret, and optional domain
    this.cookieHelper = createCookieHelper(
      this.betterAuthService.getBasePath(),
      {
        domain: crossSubDomainDomain,
        legacyCookieEnabled: legacyAuthEnabled,
        secret: betterAuthConfig?.secret,
      },
      this.logger,
    );
  }

  // ===================================================================================================================
  // Token Resolution
  // ===================================================================================================================

  /**
   * Resolves a session token to a JWT when cookies are disabled and JWT is enabled.
   * Delegates to CoreBetterAuthService.resolveJwtToken().
   *
   * @param token - The token from BetterAuth response (may be session token or JWT)
   * @returns A proper JWT token, or the original token if conversion is not needed/possible
   */
  protected async resolveJwtToken(token: string | undefined): Promise<string | undefined> {
    return this.betterAuthService.resolveJwtToken(token);
  }

  // ===================================================================================================================
  // Feature Discovery
  // ===================================================================================================================

  /**
   * Get enabled Better-Auth features
   *
   * Returns public feature flags for client-side feature detection.
   * This allows frontends to adapt their UI based on enabled features
   * (e.g., show/hide email verification step, passkey options, etc.).
   *
   * @since 11.13.0
   */
  @ApiOkResponse({ description: 'Better-Auth feature flags' })
  @ApiOperation({
    description: 'Get enabled Better-Auth features for client-side feature detection',
    summary: 'Get Features',
  })
  @Get('features')
  @Roles(RoleEnum.S_EVERYONE)
  getFeatures(): Record<string, boolean | number | string[]> {
    return {
      emailVerification: this.emailVerificationService?.isEnabled() ?? false,
      enabled: this.betterAuthService.isEnabled(),
      jwt: this.betterAuthService.isJwtEnabled(),
      passkey: this.betterAuthService.isPasskeyEnabled(),
      resendCooldownSeconds: this.emailVerificationService?.getConfig()?.resendCooldownSeconds ?? 60,
      signUpChecks: this.signUpValidator?.isEnabled() ?? false,
      signUpEnabled: this.betterAuthService.isSignUpEnabled(),
      socialProviders: this.betterAuthService.getEnabledSocialProviders(),
      twoFactor: this.betterAuthService.isTwoFactorEnabled(),
    };
  }

  // ===================================================================================================================
  // Authentication Endpoints
  // ===================================================================================================================

  /**
   * Sign in with email and password
   *
   * **Why Custom Implementation (not hooks):**
   * - Hooks cannot access plaintext password for legacy migration
   * - Hooks cannot modify response format
   * - Hooks cannot set multi-cookie auth strategy
   *
   * **Flow:**
   * 1. Try legacy user migration if the user exists in legacy system
   *    → Requires plaintext password (unavailable in after-hooks)
   * 2. Normalize password to SHA256 format for Better Auth
   * 3. Call Better Auth API directly for consistent response format
   * 4. For 2FA: Use native handler to ensure cookies are set correctly
   *    → Hooks cannot set cookies, so we use authInstance.handler()
   * 5. Return response with multiple auth cookies
   *    → Hooks cannot modify response or set cookies
   *
   * @see README.md "Architecture: Why Custom Controllers?"
   */
  @ApiBody({ type: CoreBetterAuthSignInInput })
  @ApiCreatedResponse({ description: 'Signed in successfully', type: CoreBetterAuthResponse })
  @ApiOperation({ description: 'Sign in via Better-Auth with email and password', summary: 'Sign In' })
  @HttpCode(HttpStatus.OK)
  @Post('sign-in/email')
  @Roles(RoleEnum.S_EVERYONE)
  async signIn(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() input: CoreBetterAuthSignInInput,
  ): Promise<CoreBetterAuthResponse> {
    this.ensureEnabled();

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException(ErrorCode.BETTERAUTH_API_NOT_AVAILABLE);
    }

    // Step 1: Try legacy user migration BEFORE Better Auth handles the request
    // This allows users who exist in legacy system to be migrated automatically
    try {
      const migrated = await this.userMapper.migrateAccountToIam(input.email, input.password);
      if (migrated) {
        this.logger.debug(`Migrated legacy user ${maskEmail(input.email)} to IAM`);
      }
    } catch (error) {
      // Migration failure is not fatal - user might not exist in legacy or already migrated
      this.logger.debug(`Legacy migration check: ${error instanceof Error ? error.message : 'not needed'}`);
    }

    // Step 2: Normalize password for Better Auth (SHA256 format)
    const normalizedPassword = this.userMapper.normalizePasswordForIam(input.password);

    // Step 3: Call Better Auth API to check response type
    try {
      const response = (await api.signInEmail({
        body: {
          email: input.email,
          password: normalizedPassword,
        },
      })) as BetterAuthSignInResponse | null;

      if (!response) {
        throw new UnauthorizedException(ErrorCode.INVALID_CREDENTIALS);
      }

      // Check for 2FA requirement
      // When 2FA is required, we need to use the native Better Auth handler
      // because api.signInEmail() doesn't return the session token needed for 2FA verification
      if (requires2FA(response)) {
        // Defense-in-depth: Check email verification even for 2FA users
        // Without this, users with 2FA enabled but unverified email could bypass verification
        await this.checkEmailVerificationByEmail(input.email);

        this.logger.debug(
          `2FA required for ${maskEmail(input.email)}, forwarding to native handler for cookie handling`,
        );

        // Forward to native Better Auth handler which sets the session cookie correctly
        // We need to modify the request body to use the normalized password
        const authInstance = this.betterAuthService.getInstance();
        if (!authInstance) {
          throw new InternalServerErrorException(ErrorCode.BETTERAUTH_NOT_INITIALIZED);
        }

        // Create a modified request body with normalized password
        const modifiedBody = JSON.stringify({
          email: input.email,
          password: normalizedPassword,
        });

        // Build the sign-in URL
        const basePath = this.betterAuthService.getBasePath();
        const baseUrl = this.betterAuthService.getBaseUrl();
        const signInUrl = new URL(`${basePath}/sign-in/email`, baseUrl);

        // Create a new Web Request for Better Auth's native handler
        const webRequest = new Request(signInUrl.toString(), {
          body: modifiedBody,
          headers: new Headers({
            'Content-Type': 'application/json',
            Origin: req.headers.origin || baseUrl,
          }),
          method: 'POST',
        });

        // Call Better Auth's native handler
        const nativeResponse = await authInstance.handler(webRequest);

        // Extract and forward Set-Cookie headers
        const setCookieHeaders = nativeResponse.headers.getSetCookie?.() || [];
        for (const cookie of setCookieHeaders) {
          res.setHeader('Set-Cookie', cookie);
        }

        // Return the structured response
        return {
          requiresTwoFactor: true,
          success: false,
        };
      }

      // Check if response indicates an error
      const responseAny = response as any;
      if (responseAny?.error || responseAny?.code === 'CREDENTIAL_ACCOUNT_NOT_FOUND') {
        throw new UnauthorizedException(ErrorCode.INVALID_CREDENTIALS);
      }

      if (hasUser(response)) {
        // Check email verification before allowing login
        this.checkEmailVerification(response.user);

        // Link or create user in our database (in case it doesn't exist)
        await this.userMapper.linkOrCreateUser(response.user);

        const mappedUser = await this.userMapper.mapSessionUser(response.user);

        // Get token: JWT accessToken > top-level token > session.token
        const rawToken =
          responseAny.accessToken || responseAny.token || (hasSession(response) ? response.session.token : undefined);
        const token = await this.resolveJwtToken(rawToken);

        const result: CoreBetterAuthResponse = {
          requiresTwoFactor: false,
          session: hasSession(response) ? this.mapSession(response.session) : undefined,
          success: true,
          token,
          user: mappedUser ? this.mapUser(response.user, mappedUser) : undefined,
        };

        return this.processCookies(res, result);
      }

      throw new UnauthorizedException(ErrorCode.INVALID_CREDENTIALS);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`Sign-in error: ${errorMessage}`);

      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException(ErrorCode.INVALID_CREDENTIALS);
    }
  }

  /**
   * Sign up with email and password
   *
   * **Why Custom Implementation (not hooks):**
   * - After-hooks don't have access to plaintext password
   *   → Cannot call syncPasswordToLegacy() in hooks
   * - Hooks cannot access NestJS services
   *   → Cannot use UserMapper for user linking
   * - Hooks cannot modify response format
   *
   * **Custom Logic:**
   * 1. Normalize password to SHA256 for Better Auth storage
   * 2. Create user via Better Auth API
   * 3. Link user to Legacy system (requires NestJS UserMapper)
   * 4. Sync plaintext password to Legacy Auth (bcrypt hash)
   *    → CRITICAL: This requires plaintext, unavailable in after-hooks
   * 5. Return response with session cookies
   *
   * @see README.md "Architecture: Why Custom Controllers?"
   */
  @ApiBody({ type: CoreBetterAuthSignUpInput })
  @ApiCreatedResponse({ description: 'Signed up successfully', type: CoreBetterAuthResponse })
  @ApiOperation({ description: 'Sign up via Better-Auth with email and password', summary: 'Sign Up' })
  @Post('sign-up/email')
  @Roles(RoleEnum.S_EVERYONE)
  async signUp(
    @Res({ passthrough: true }) res: Response,
    @Body() input: CoreBetterAuthSignUpInput,
  ): Promise<CoreBetterAuthResponse> {
    this.ensureEnabled();
    this.betterAuthService.ensureSignUpEnabled();

    // Validate sign-up input (termsAndPrivacyAccepted is required by default)
    if (this.signUpValidator) {
      this.signUpValidator.validateSignUpInput({ termsAndPrivacyAccepted: input.termsAndPrivacyAccepted });
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException(ErrorCode.BETTERAUTH_API_NOT_AVAILABLE);
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
        throw new BadRequestException(ErrorCode.SIGNUP_FAILED);
      }

      if (hasUser(response)) {
        // Link or create user in our database
        // Pass termsAndPrivacyAccepted to store the acceptance timestamp
        await this.userMapper.linkOrCreateUser(response.user, {
          termsAndPrivacyAccepted: input.termsAndPrivacyAccepted,
        });

        // Sync password to legacy (enables IAM Sign-Up → Legacy Sign-In)
        // Pass the plain password so it can be hashed with bcrypt for Legacy Auth
        await this.userMapper.syncPasswordToLegacy(response.user.id, response.user.email, input.password);

        const mappedUser = await this.userMapper.mapSessionUser(response.user);

        // Get token: JWT accessToken > top-level token > session.token
        // Without this, no session cookies are set after sign-up, causing 401 on
        // subsequent authenticated requests (e.g., Passkey, 2FA, /token)
        const responseAny = response as any;
        const rawToken =
          responseAny.accessToken || responseAny.token || (hasSession(response) ? response.session.token : undefined);
        const token = await this.resolveJwtToken(rawToken);

        // If email verification is enabled, revoke the session and don't return session data
        // The user must verify their email before they can use any session
        if (this.emailVerificationService?.isEnabled()) {
          // Revoke the Better-Auth session server-side so the token is invalidated
          const sessionToken = hasSession(response) ? response.session.token : undefined;
          if (sessionToken) {
            await this.betterAuthService.revokeSession(sessionToken);
          }
          this.clearAuthCookies(res);
          this.logger.debug(
            `[SignUp] Email verification required for ${maskEmail(response.user.email)}, session revoked`,
          );
          return {
            emailVerificationRequired: true,
            requiresTwoFactor: false,
            success: true,
            user: mappedUser ? this.mapUser(response.user, mappedUser) : undefined,
          };
        }

        const result: CoreBetterAuthResponse = {
          requiresTwoFactor: false,
          session: hasSession(response) ? this.mapSession(response.session) : undefined,
          success: true,
          token,
          user: mappedUser ? this.mapUser(response.user, mappedUser) : undefined,
        };

        return this.processCookies(res, result);
      }

      throw new BadRequestException(ErrorCode.SIGNUP_FAILED);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`Sign-up error: ${errorMessage}`);
      if (errorMessage.includes('already exists')) {
        throw new BadRequestException(ErrorCode.EMAIL_ALREADY_EXISTS);
      }
      throw new BadRequestException(ErrorCode.SIGNUP_FAILED);
    }
  }

  /**
   * Sign out (logout)
   *
   * **Why Custom Implementation (not hooks):**
   * - Must clear session cookies (basePath.session_token + optional legacy token)
   * - Hooks cannot modify response or set/clear cookies
   *
   * NOTE: Better-Auth uses POST for sign-out (matches better-auth convention)
   *
   * @see README.md "Architecture: Why Custom Controllers?"
   */
  @ApiOkResponse({ description: 'Signed out successfully', type: CoreBetterAuthResponse })
  @ApiOperation({ description: 'Sign out from Better-Auth', summary: 'Sign Out' })
  @Post('sign-out')
  @Roles(RoleEnum.S_EVERYONE)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<CoreBetterAuthResponse> {
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
   *
   * **Why Custom Implementation (not hooks):**
   * - Must map Better Auth user to nest-server user with roles
   * - Hooks cannot access NestJS UserMapper service
   * - Custom response format with mapped user data
   *
   * @see README.md "Architecture: Why Custom Controllers?"
   */
  @ApiOkResponse({ description: 'Current session', type: CoreBetterAuthResponse })
  @ApiOperation({ description: 'Get current session from Better-Auth', summary: 'Get Session' })
  @Get('session')
  @Roles(RoleEnum.S_EVERYONE)
  async getSession(@Req() req: Request): Promise<CoreBetterAuthResponse> {
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
  // Catch-All Route for Better Auth Plugins
  // ===================================================================================================================

  /**
   * Catch-all route for all other Better Auth plugin endpoints.
   *
   * **This route USES the native Better Auth handler** via `authInstance.handler()`.
   * It's the best of both worlds:
   * - Custom endpoints where we need NestJS features (sign-in, sign-up, etc.)
   * - Native handler for plugins that work correctly out-of-the-box
   *
   * **Why Not Fully Native:**
   * Even this catch-all requires custom logic:
   * - Session token injection into request (before-hooks can't inject tokens)
   * - Converting Express Request to Web Standard Request
   *
   * **Handles:**
   * - Passkey/WebAuthn (all endpoints)
   * - Two-Factor Authentication (all endpoints)
   * - Social Login OAuth flows
   * - Email verification
   * - Magic link authentication
   * - Any other Better Auth plugin functionality
   *
   * IMPORTANT: This route must be defined LAST in the controller to ensure
   * it doesn't intercept the explicitly defined routes above.
   *
   * Better Auth handles authentication internally - it returns appropriate
   * errors (401, 403) if a user is not authenticated for protected endpoints.
   *
   * @see README.md "Architecture: Why Custom Controllers?"
   */
  @All('*path')
  @Roles(RoleEnum.S_EVERYONE)
  async handlePluginRoutes(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.handleBetterAuthPlugins(req, res);
  }

  // ===================================================================================================================
  // Helper Methods (protected for extension)
  // ===================================================================================================================

  /**
   * Ensure Better-Auth is enabled
   */
  protected ensureEnabled(): void {
    if (!this.betterAuthService.isEnabled()) {
      throw new BadRequestException(ErrorCode.BETTERAUTH_DISABLED);
    }
  }

  /**
   * Check if email verification is required and the user's email is verified.
   * Throws UnauthorizedException with EMAIL_VERIFICATION_REQUIRED if:
   * - emailVerificationService is available AND enabled
   * - AND the user's email is NOT verified
   *
   * Override this method to customize the email verification check behavior.
   *
   * @param sessionUser - The user from Better-Auth sign-in response
   * @throws UnauthorizedException if email is not verified and verification is required
   */
  protected checkEmailVerification(sessionUser: BetterAuthSessionUser): void {
    if (this.emailVerificationService?.isEnabled() && !sessionUser.emailVerified) {
      this.logger.debug(`[SignIn] Email not verified for ${maskEmail(sessionUser.email)}, blocking login`);
      throw new UnauthorizedException(ErrorCode.EMAIL_VERIFICATION_REQUIRED);
    }
  }

  /**
   * Check email verification by looking up the user by email address.
   *
   * This is used in the 2FA path where the sign-in response does NOT include user data
   * (only a 2FA challenge), so we cannot use checkEmailVerification(sessionUser).
   * Instead, we look up the user via CoreBetterAuthService.isUserEmailVerified().
   *
   * @param email - The email address to check
   * @throws UnauthorizedException if email is not verified and verification is required
   */
  protected async checkEmailVerificationByEmail(email: string): Promise<void> {
    if (!this.emailVerificationService?.isEnabled()) {
      return;
    }

    const verified = await this.betterAuthService.isUserEmailVerified(email);
    if (verified === false) {
      this.logger.debug(`[SignIn/2FA] Email not verified for ${maskEmail(email)}, blocking login`);
      throw new UnauthorizedException(ErrorCode.EMAIL_VERIFICATION_REQUIRED);
    }
  }

  /**
   * Extract session token from request
   *
   * Cookie priority (v11.12+):
   * 1. Authorization: Bearer header (only if it's a session token, NOT a JWT)
   * 2. `{basePath}.session_token` (e.g., `iam.session_token`) - Better-Auth native
   * 3. `token` - Legacy compatibility (only if Legacy Auth might be active)
   *
   * JWTs in the Authorization header are NOT returned here because they cannot
   * be used as session tokens for BetterAuth's plugin endpoints (2FA, Passkey, etc.).
   * The middleware resolves JWTs to sessions separately via getActiveSessionForUser().
   */
  protected extractSessionToken(req: Request): null | string {
    // Check Authorization header - only return session tokens, not JWTs
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const bearerToken = authHeader.substring(7);
      if (isSessionToken(bearerToken)) {
        return bearerToken;
      }
    }

    // Check cookies - Better-Auth native cookie first, then legacy token
    const basePath = this.betterAuthService.getBasePath().replace(/^\//, '').replace(/\//g, '.');
    const cookieName = `${basePath}.session_token`;
    return req.cookies?.[cookieName] || req.cookies?.['token'] || null;
  }

  /**
   * Extract headers for Better-Auth API calls
   */
  protected extractHeaders(req: Request): Headers {
    return convertExpressHeaders(req.headers as Record<string, string | string[] | undefined>);
  }

  /**
   * Map session to response format
   *
   * NOTE: The session token is intentionally NOT included in the response.
   * It is set as an httpOnly cookie for security.
   */
  protected mapSession(
    session: null | undefined | { expiresAt: Date; id: string; token?: string },
  ): CoreBetterAuthSessionInfo | undefined {
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

  protected mapUser(sessionUser: BetterAuthSessionUser, _mappedUser: any): CoreBetterAuthUserResponse {
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
   * Sets multiple cookies for authentication compatibility using the centralized cookie helper.
   * See BetterAuthCookieHelper for the complete cookie strategy.
   *
   * IMPORTANT: Better Auth's sign-in returns a session token in `result.token`.
   * This is NOT a JWT - it's the session token stored in the database.
   * The JWT plugin generates JWTs separately via the /token endpoint when needed.
   *
   * @param res - Express Response object
   * @param result - The CoreBetterAuthResponse to return
   * @param sessionToken - Optional session token to set in cookies (if not provided, uses result.token)
   */
  protected processCookies(
    res: Response,
    result: CoreBetterAuthResponse,
    sessionToken?: string,
  ): CoreBetterAuthResponse {
    const cookiesEnabled = this.configService.getFastButReadOnly('cookies') !== false;

    // If a specific session token is provided, use it directly
    if (sessionToken && cookiesEnabled) {
      this.cookieHelper.setSessionCookies(res, sessionToken, result.session?.id);
      if (result.token) {
        delete result.token;
      }
      return result;
    }

    // Otherwise, use the cookie helper's standard processing
    return this.cookieHelper.processAuthResult(res, result, cookiesEnabled);
  }

  /**
   * Clear authentication cookies using the centralized cookie helper.
   */
  protected clearAuthCookies(res: Response): void {
    this.cookieHelper.clearSessionCookies(res);
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
      throw new InternalServerErrorException(ErrorCode.BETTERAUTH_NOT_INITIALIZED);
    }

    this.logger.debug(`Forwarding to Better Auth: ${req.method} ${req.path}`);

    try {
      // Extract session token from the validated middleware session or cookies
      const sessionToken = this.getSessionTokenFromRequest(req);

      this.logger.debug(`Session token for forwarding: ${maskToken(sessionToken)}`);

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

      this.logger.debug(`Better Auth handler response status: ${response.status}`);

      // Send the response back
      await sendWebResponse(res, response);
    } catch (error) {
      this.logger.error(`Better Auth handler error: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Re-throw NestJS exceptions
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException ||
        error instanceof InternalServerErrorException
      ) {
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
