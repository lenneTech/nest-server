import { BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Request, Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { maskEmail } from '../../common/helpers/logging.helper';
import { ErrorCode } from '../error-code/error-codes';
import {
  BetterAuth2FAResponse,
  BetterAuthSignInResponse,
  BetterAuthSignUpResponse,
  hasSession,
  hasUser,
  requires2FA,
} from './better-auth.types';
import { CoreBetterAuthAuthModel } from './core-better-auth-auth.model';
import { CoreBetterAuthMigrationStatusModel } from './core-better-auth-migration-status.model';
import {
  CoreBetterAuth2FASetupModel,
  CoreBetterAuthFeaturesModel,
  CoreBetterAuthPasskeyChallengeModel,
  CoreBetterAuthPasskeyModel,
  CoreBetterAuthSessionModel,
  CoreBetterAuthUserModel,
} from './core-better-auth-models';
import { BetterAuthSessionUser, CoreBetterAuthUserMapper, MappedUser } from './core-better-auth-user.mapper';
import { CoreBetterAuthService } from './core-better-auth.service';

/**
 * Abstract GraphQL Resolver for Better-Auth operations
 *
 * This resolver provides GraphQL mutations that wrap the Better-Auth REST API,
 * making it compatible with existing GraphQL clients while using Better-Auth
 * for authentication.
 *
 * This resolver is abstract (`isAbstract: true`) and meant to be extended
 * by consuming projects. Override any method to add custom behavior.
 *
 * @example
 * ```typescript
 * // In your project's better-auth.resolver.ts
 * @Resolver(() => CoreBetterAuthAuthModel)
 * export class BetterAuthResolver extends CoreBetterAuthResolver {
 *   constructor(
 *     betterAuthService: CoreBetterAuthService,
 *     userMapper: CoreBetterAuthUserMapper,
 *     private readonly emailService: EmailService,
 *   ) {
 *     super(betterAuthService, userMapper);
 *   }
 *
 *   // Override signUp to add custom logic
 *   override async betterAuthSignUp(email: string, password: string, name?: string) {
 *     const result = await super.betterAuthSignUp(email, password, name);
 *     if (result.success && result.user) {
 *       await this.emailService.sendWelcomeEmail(result.user.email);
 *     }
 *     return result;
 *   }
 * }
 * ```
 */
@Resolver(() => CoreBetterAuthAuthModel, { isAbstract: true })
@Roles(RoleEnum.ADMIN)
export class CoreBetterAuthResolver {
  protected readonly logger = new Logger(CoreBetterAuthResolver.name);

  constructor(
    protected readonly betterAuthService: CoreBetterAuthService,
    protected readonly userMapper: CoreBetterAuthUserMapper,
  ) {}

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get current Better-Auth session
   */
  @Query(() => CoreBetterAuthSessionModel, {
    description: 'Get current Better-Auth session',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  async betterAuthSession(@Context() ctx: { req: Request }): Promise<CoreBetterAuthSessionModel | null> {
    if (!this.betterAuthService.isEnabled()) {
      return null;
    }

    const { session, user } = await this.betterAuthService.getSession(ctx.req);

    if (!session || !user) {
      return null;
    }

    return {
      expiresAt: session.expiresAt,
      id: session.id,
      user: {
        email: user.email,
        emailVerified: user.emailVerified,
        id: user.id,
        name: user.name,
      },
    };
  }

  /**
   * Check if Better-Auth is enabled
   */
  @Query(() => Boolean, { description: 'Check if Better-Auth is enabled' })
  @Roles(RoleEnum.S_EVERYONE)
  betterAuthEnabled(): boolean {
    return this.betterAuthService.isEnabled();
  }

  /**
   * Get enabled Better-Auth features
   */
  @Query(() => CoreBetterAuthFeaturesModel, { description: 'Get enabled Better-Auth features' })
  @Roles(RoleEnum.S_EVERYONE)
  betterAuthFeatures(): CoreBetterAuthFeaturesModel {
    return {
      enabled: this.betterAuthService.isEnabled(),
      jwt: this.betterAuthService.isJwtEnabled(),
      passkey: this.betterAuthService.isPasskeyEnabled(),
      socialProviders: this.betterAuthService.getEnabledSocialProviders(),
      twoFactor: this.betterAuthService.isTwoFactorEnabled(),
    };
  }

  /**
   * Get a fresh JWT token for the current session.
   *
   * Use this when your JWT has expired but your session is still valid.
   * The JWT can be used for stateless authentication with other services
   * that verify tokens via JWKS (`/iam/jwks`).
   *
   * Returns null if:
   * - Better-Auth is not enabled
   * - JWT plugin is not enabled
   * - No valid session exists
   */
  @Query(() => String, {
    description: 'Get fresh JWT token for the current session (requires valid session)',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  async betterAuthToken(@Context() ctx: { req: Request }): Promise<null | string> {
    return this.betterAuthService.getToken(ctx.req);
  }

  /**
   * Get migration status from Legacy Auth to Better-Auth (IAM)
   *
   * This query provides administrators with information about how many users
   * have been migrated to the IAM system. This helps determine when it might
   * be safe to consider disabling Legacy Auth endpoints.
   *
   * A user is considered fully migrated when:
   * 1. They have an `iamId` set (linked to Better-Auth)
   * 2. They have a credential account in Better-Auth
   *
   * Note: Even when canDisableLegacyAuth returns true, Legacy Auth cannot
   * currently be removed because CoreModule.forRoot requires AuthService
   * for GraphQL Subscriptions authentication.
   */
  @Query(() => CoreBetterAuthMigrationStatusModel, {
    description: 'Get migration status from Legacy Auth to Better-Auth (IAM) - Admin only',
  })
  @Roles(RoleEnum.ADMIN)
  async betterAuthMigrationStatus(): Promise<CoreBetterAuthMigrationStatusModel> {
    const status = await this.userMapper.getMigrationStatus();
    return status;
  }

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Sign in via Better-Auth
   *
   * This mutation wraps Better-Auth's sign-in endpoint and returns a response
   * compatible with the existing auth system.
   *
   * Features automatic legacy user migration: If a user exists in Legacy Auth
   * but not in IAM, they will be automatically migrated on first IAM sign-in.
   *
   * Override this method to add custom pre/post sign-in logic.
   */
  @Mutation(() => CoreBetterAuthAuthModel, {
    description: 'Sign in via Better-Auth (email/password)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  async betterAuthSignIn(
    @Args('email') email: string,
    @Args('password') password: string,
     
    @Context() _ctx: { req: Request; res: Response },
  ): Promise<CoreBetterAuthAuthModel> {
    this.ensureEnabled();

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException(ErrorCode.BETTERAUTH_API_NOT_AVAILABLE);
    }

    // Try to sign in, with automatic legacy user migration
    return this.attemptSignIn(email, password, api, true);
  }

  /**
   * Attempt sign-in with optional legacy user migration
   * @param email - User email
   * @param password - User password (plain or SHA256)
   * @param api - Better-Auth API instance
   * @param allowMigration - Whether to attempt legacy migration on failure
   */
  protected async attemptSignIn(
    email: string,
    password: string,
    api: ReturnType<CoreBetterAuthService['getApi']>,
    allowMigration: boolean,
  ): Promise<CoreBetterAuthAuthModel> {
    try {
      // Try sign-in with original password first (for native IAM users)
      const response = (await api!.signInEmail({
        body: { email, password },
      })) as BetterAuthSignInResponse | null;

      this.logger.debug(`[SignIn] API response for ${maskEmail(email)}: ${JSON.stringify(response)?.substring(0, 200)}`);

      // Check if response indicates an error (Better-Auth returns error objects, not throws)
      const responseAny = response as any;
      if (responseAny?.error || responseAny?.code === 'CREDENTIAL_ACCOUNT_NOT_FOUND') {
        this.logger.debug(`[SignIn] API returned error for ${maskEmail(email)}: ${responseAny?.error || responseAny?.code}`);
        throw new Error(responseAny?.error || responseAny?.code || 'Credential account not found');
      }

      if (!response) {
        throw new UnauthorizedException(ErrorCode.INVALID_CREDENTIALS);
      }

      // Check for 2FA requirement
      if (requires2FA(response)) {
        return {
          requiresTwoFactor: true,
          success: false,
          user: null,
        };
      }

      // Get user data
      if (hasUser(response)) {
        const sessionUser: BetterAuthSessionUser = response.user;
        const mappedUser = await this.userMapper.mapSessionUser(sessionUser);

        // Return the session token for session-based authentication
        // Note: If JWT plugin is enabled, accessToken may be in response or in set-auth-jwt header
        // For GraphQL responses, we return the session token and let clients use it for session auth
        const responseAny = response as any;
        const token = responseAny.accessToken || responseAny.token;

        return {
          requiresTwoFactor: false,
          session: hasSession(response) ? this.mapSessionInfo(response.session) : null,
          success: true,
          token,
          user: mappedUser ? this.mapToUserModel(mappedUser) : null,
        };
      }

      throw new UnauthorizedException(ErrorCode.INVALID_CREDENTIALS);
    } catch (error) {
      this.logger.debug(
        `[SignIn] Sign-in failed for ${maskEmail(email)}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );

      // If migration is allowed, try to migrate legacy user and retry
      if (allowMigration) {
        this.logger.debug(`[SignIn] Attempting migration for ${maskEmail(email)}...`);
        // Pass the original password for legacy verification
        const migrated = await this.userMapper.migrateAccountToIam(email, password);
        this.logger.debug(`[SignIn] Migration result for ${maskEmail(email)}: ${migrated}`);
        if (migrated) {
          this.logger.debug(`[SignIn] Migrated legacy user ${maskEmail(email)} to IAM, retrying sign-in`);
          // Retry sign-in after migration with normalized password (as migrateAccountToIam stores it)
          const normalizedPassword = this.userMapper.normalizePasswordForIam(password);
          return this.attemptSignInDirect(email, normalizedPassword, api);
        }
      }

      throw new UnauthorizedException(ErrorCode.INVALID_CREDENTIALS);
    }
  }

  /**
   * Direct sign-in attempt without migration logic (used after migration)
   */
  private async attemptSignInDirect(
    email: string,
    password: string,
    api: ReturnType<CoreBetterAuthService['getApi']>,
  ): Promise<CoreBetterAuthAuthModel> {
    const response = (await api!.signInEmail({
      body: { email, password },
    })) as BetterAuthSignInResponse | null;

    if (!response || !hasUser(response)) {
      throw new UnauthorizedException(ErrorCode.INVALID_CREDENTIALS);
    }

    if (requires2FA(response)) {
      return { requiresTwoFactor: true, success: false, user: null };
    }

    const sessionUser: BetterAuthSessionUser = response.user;
    const mappedUser = await this.userMapper.mapSessionUser(sessionUser);
    // Return accessToken if available (JWT), otherwise fall back to session token
    const responseAny = response as any;
    const token = responseAny.accessToken || responseAny.token;

    return {
      requiresTwoFactor: false,
      session: hasSession(response) ? this.mapSessionInfo(response.session) : null,
      success: true,
      token,
      user: mappedUser ? this.mapToUserModel(mappedUser) : null,
    };
  }

  /**
   * Sign up via Better-Auth
   *
   * Override this method to add custom pre/post sign-up logic (e.g., sending welcome emails).
   */
  @Mutation(() => CoreBetterAuthAuthModel, {
    description: 'Sign up via Better-Auth (email/password)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  async betterAuthSignUp(
    @Args('email') email: string,
    @Args('password') password: string,
    @Args('name', { nullable: true }) name?: string,
  ): Promise<CoreBetterAuthAuthModel> {
    this.ensureEnabled();

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException(ErrorCode.BETTERAUTH_API_NOT_AVAILABLE);
    }

    try {
      const response = (await api.signUpEmail({
        body: {
          email,
          name: name || email.split('@')[0],
          password,
        },
      })) as BetterAuthSignUpResponse | null;

      if (!response) {
        throw new BadRequestException(ErrorCode.SIGNUP_FAILED);
      }

      if (hasUser(response)) {
        const sessionUser: BetterAuthSessionUser = response.user;

        // Link or create user in our database
        await this.userMapper.linkOrCreateUser(sessionUser);
        const mappedUser = await this.userMapper.mapSessionUser(sessionUser);

        return {
          requiresTwoFactor: false,
          session: hasSession(response) ? this.mapSessionInfo(response.session) : null,
          success: true,
          user: mappedUser ? this.mapToUserModel(mappedUser) : null,
        };
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
   * Sign out via Better-Auth
   */
  @Mutation(() => Boolean, { description: 'Sign out via Better-Auth' })
  @Roles(RoleEnum.S_USER)
  async betterAuthSignOut(@Context() ctx: { req: Request }): Promise<boolean> {
    if (!this.betterAuthService.isEnabled()) {
      return false;
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      return false;
    }

    try {
      const headers = this.convertHeaders(ctx.req.headers);
      await api.signOut({ headers });
      return true;
    } catch (error) {
      this.logger.debug(`Sign-out error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  /**
   * Verify 2FA code
   */
  @Mutation(() => CoreBetterAuthAuthModel, {
    description: 'Verify 2FA code during sign-in',
  })
  @Roles(RoleEnum.S_EVERYONE)
  async betterAuthVerify2FA(
    @Args('code') code: string,
    @Context() ctx: { req: Request },
  ): Promise<CoreBetterAuthAuthModel> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      throw new BadRequestException(ErrorCode.TWO_FACTOR_NOT_ENABLED_SERVER);
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException(ErrorCode.BETTERAUTH_API_NOT_AVAILABLE);
    }

    try {
      // Convert headers
      const headers = this.convertHeaders(ctx.req.headers);

      // Better-Auth's 2FA plugin adds twoFactor methods dynamically

      const twoFactorApi = (api as Record<string, unknown>).twoFactor as
        | undefined
        | {
            verifyTotp?: (params: { body: { code: string }; headers: Headers }) => Promise<BetterAuth2FAResponse>;
          };

      if (!twoFactorApi?.verifyTotp) {
        throw new BadRequestException(ErrorCode.TWO_FACTOR_METHOD_NOT_AVAILABLE);
      }

      const response = await twoFactorApi.verifyTotp({
        body: { code },
        headers,
      });

      if (response && hasUser(response)) {
        const sessionUser: BetterAuthSessionUser = response.user;
        const mappedUser = await this.userMapper.mapSessionUser(sessionUser);

        return {
          requiresTwoFactor: false,
          success: true,
          user: mappedUser ? this.mapToUserModel(mappedUser) : null,
        };
      }

      throw new UnauthorizedException(ErrorCode.INVALID_2FA_CODE);
    } catch (error) {
      this.logger.debug(`2FA verification error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new UnauthorizedException(ErrorCode.INVALID_2FA_CODE);
    }
  }

  // ===========================================================================
  // 2FA Management Mutations
  // ===========================================================================

  /**
   * Enable 2FA for the current user
   * Returns TOTP URI for QR code generation and backup codes
   */
  @Mutation(() => CoreBetterAuth2FASetupModel, {
    description: 'Enable 2FA for the current user',
  })
  @Roles(RoleEnum.S_USER)
  async betterAuthEnable2FA(
    @Args('password') password: string,
    @Context() ctx: { req: Request },
  ): Promise<CoreBetterAuth2FASetupModel> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      return { error: 'Two-factor authentication is not enabled on this server', success: false };
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      return { error: 'Better-Auth API not available', success: false };
    }

    try {
      const headers = this.convertHeaders(ctx.req.headers);

      const twoFactorApi = (api as Record<string, unknown>).twoFactor as
        | undefined
        | {
            enable?: (params: { body: { password: string }; headers: Headers }) => Promise<{
              backupCodes?: string[];
              totpURI?: string;
            }>;
          };

      if (!twoFactorApi?.enable) {
        return { error: '2FA enable method not available', success: false };
      }

      const response = await twoFactorApi.enable({
        body: { password },
        headers,
      });

      return {
        backupCodes: response.backupCodes,
        success: true,
        totpUri: response.totpURI,
      };
    } catch (error) {
      this.logger.debug(`2FA enable error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { error: error instanceof Error ? error.message : 'Failed to enable 2FA', success: false };
    }
  }

  /**
   * Disable 2FA for the current user
   */
  @Mutation(() => Boolean, {
    description: 'Disable 2FA for the current user',
  })
  @Roles(RoleEnum.S_USER)
  async betterAuthDisable2FA(@Args('password') password: string, @Context() ctx: { req: Request }): Promise<boolean> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      throw new BadRequestException(ErrorCode.TWO_FACTOR_NOT_ENABLED_SERVER);
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      return false;
    }

    try {
      const headers = this.convertHeaders(ctx.req.headers);

      const twoFactorApi = (api as Record<string, unknown>).twoFactor as
        | undefined
        | {
            disable?: (params: { body: { password: string }; headers: Headers }) => Promise<{ status: boolean }>;
          };

      if (!twoFactorApi?.disable) {
        throw new BadRequestException(ErrorCode.TWO_FACTOR_METHOD_NOT_AVAILABLE);
      }

      const response = await twoFactorApi.disable({
        body: { password },
        headers,
      });

      return response?.status === true;
    } catch (error) {
      this.logger.debug(`2FA disable error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  /**
   * Generate new backup codes for 2FA
   */
  @Mutation(() => [String], {
    description: 'Generate new backup codes for 2FA',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  async betterAuthGenerateBackupCodes(@Context() ctx: { req: Request }): Promise<null | string[]> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      throw new BadRequestException(ErrorCode.TWO_FACTOR_NOT_ENABLED_SERVER);
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      return null;
    }

    try {
      const headers = this.convertHeaders(ctx.req.headers);

      const twoFactorApi = (api as Record<string, unknown>).twoFactor as
        | undefined
        | {
            generateBackupCodes?: (params: { headers: Headers }) => Promise<{ backupCodes?: string[] }>;
          };

      if (!twoFactorApi?.generateBackupCodes) {
        throw new BadRequestException(ErrorCode.TWO_FACTOR_METHOD_NOT_AVAILABLE);
      }

      const response = await twoFactorApi.generateBackupCodes({ headers });

      return response?.backupCodes || null;
    } catch (error) {
      this.logger.debug(`Generate backup codes error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  // ===========================================================================
  // Passkey Management Mutations
  // ===========================================================================

  /**
   * Get passkey registration challenge
   * Returns the challenge data needed for WebAuthn registration
   */
  @Mutation(() => CoreBetterAuthPasskeyChallengeModel, {
    description: 'Get passkey registration challenge for WebAuthn',
  })
  @Roles(RoleEnum.S_USER)
  async betterAuthGetPasskeyChallenge(@Context() ctx: { req: Request }): Promise<CoreBetterAuthPasskeyChallengeModel> {
    this.ensureEnabled();

    if (!this.betterAuthService.isPasskeyEnabled()) {
      return { error: 'Passkey authentication is not enabled on this server', success: false };
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      return { error: 'Better-Auth API not available', success: false };
    }

    try {
      const headers = this.convertHeaders(ctx.req.headers);

      const passkeyApi = (api as Record<string, unknown>).passkey as
        | undefined
        | {
            generateRegisterOptions?: (params: { headers: Headers }) => Promise<unknown>;
          };

      if (!passkeyApi?.generateRegisterOptions) {
        return { error: 'Passkey registration method not available', success: false };
      }

      const challenge = await passkeyApi.generateRegisterOptions({ headers });

      return {
        challenge: JSON.stringify(challenge),
        success: true,
      };
    } catch (error) {
      this.logger.debug(`Passkey challenge error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { error: error instanceof Error ? error.message : 'Failed to get passkey challenge', success: false };
    }
  }

  /**
   * List passkeys for the current user
   */
  @Query(() => [CoreBetterAuthPasskeyModel], {
    description: 'List passkeys for the current user',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  async betterAuthListPasskeys(@Context() ctx: { req: Request }): Promise<CoreBetterAuthPasskeyModel[] | null> {
    if (!this.betterAuthService.isEnabled() || !this.betterAuthService.isPasskeyEnabled()) {
      return null;
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      return null;
    }

    try {
      const headers = this.convertHeaders(ctx.req.headers);

      const passkeyApi = (api as Record<string, unknown>).passkey as
        | undefined
        | {
            listUserPasskeys?: (params: {
              headers: Headers;
            }) => Promise<{ createdAt: Date; credentialID: string; id: string; name?: string }[]>;
          };

      if (!passkeyApi?.listUserPasskeys) {
        return null;
      }

      const passkeys = await passkeyApi.listUserPasskeys({ headers });

      return passkeys.map((pk) => ({
        createdAt: pk.createdAt,
        credentialId: pk.credentialID,
        id: pk.id,
        name: pk.name,
      }));
    } catch (error) {
      this.logger.debug(`List passkeys error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Delete a passkey
   */
  @Mutation(() => Boolean, {
    description: 'Delete a passkey by ID',
  })
  @Roles(RoleEnum.S_USER)
  async betterAuthDeletePasskey(
    @Args('passkeyId') passkeyId: string,
    @Context() ctx: { req: Request },
  ): Promise<boolean> {
    this.ensureEnabled();

    if (!this.betterAuthService.isPasskeyEnabled()) {
      throw new BadRequestException(ErrorCode.PASSKEY_NOT_ENABLED_SERVER);
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      return false;
    }

    try {
      const headers = this.convertHeaders(ctx.req.headers);

      const passkeyApi = (api as Record<string, unknown>).passkey as
        | undefined
        | {
            deletePasskey?: (params: { body: { id: string }; headers: Headers }) => Promise<{ status: boolean }>;
          };

      if (!passkeyApi?.deletePasskey) {
        throw new BadRequestException(ErrorCode.TWO_FACTOR_METHOD_NOT_AVAILABLE);
      }

      const response = await passkeyApi.deletePasskey({
        body: { id: passkeyId },
        headers,
      });

      return response?.status === true;
    } catch (error) {
      this.logger.debug(`Delete passkey error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  // ===========================================================================
  // Helper Methods (protected for extension)
  // ===========================================================================

  /**
   * Ensure Better-Auth is enabled
   */
  protected ensureEnabled(): void {
    if (!this.betterAuthService.isEnabled()) {
      throw new BadRequestException(ErrorCode.BETTERAUTH_DISABLED);
    }
  }

  /**
   * Convert Express headers to Web API Headers
   */
  protected convertHeaders(headers: Record<string, string | string[] | undefined>): Headers {
    const result = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result.set(key, value);
      } else if (Array.isArray(value)) {
        result.set(key, value.join(', '));
      }
    }
    return result;
  }

  /**
   * Map session response to session info model
   */
  protected mapSessionInfo(session: { createdAt?: Date; expiresAt?: Date; id?: string; token?: string }): {
    expiresAt?: Date;
    id?: string;
    token?: string;
  } {
    return {
      expiresAt: session.expiresAt,
      id: session.id,
      token: session.token,
    };
  }

  /**
   * Map MappedUser to CoreBetterAuthUserModel
   */
  protected mapToUserModel(user: MappedUser): CoreBetterAuthUserModel {
    return {
      email: user.email,
      emailVerified: user.emailVerified,
      iamId: user.iamId,
      id: user.id,
      name: user.name,
      roles: user.roles,
      verified: user.verified,
    };
  }
}
