import { BadRequestException, Logger, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Request, Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { AuthGuardStrategy } from '../auth/auth-guard-strategy.enum';
import { AuthGuard } from '../auth/guards/auth.guard';
import { BetterAuthAuthModel } from './better-auth-auth.model';
import {
  BetterAuth2FASetupModel,
  BetterAuthFeaturesModel,
  BetterAuthPasskeyChallengeModel,
  BetterAuthPasskeyModel,
  BetterAuthSessionModel,
  BetterAuthUserModel,
} from './better-auth-models';
import { BetterAuthSessionUser, BetterAuthUserMapper, MappedUser } from './better-auth-user.mapper';
import { BetterAuthService } from './better-auth.service';
import {
  BetterAuth2FAResponse,
  BetterAuthSignInResponse,
  BetterAuthSignUpResponse,
  hasSession,
  hasUser,
  requires2FA,
} from './better-auth.types';

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
 * @Resolver(() => BetterAuthAuthModel)
 * export class BetterAuthResolver extends CoreBetterAuthResolver {
 *   constructor(
 *     betterAuthService: BetterAuthService,
 *     userMapper: BetterAuthUserMapper,
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
@Resolver(() => BetterAuthAuthModel, { isAbstract: true })
@Roles(RoleEnum.ADMIN)
export class CoreBetterAuthResolver {
  protected readonly logger = new Logger(CoreBetterAuthResolver.name);

  constructor(
    protected readonly betterAuthService: BetterAuthService,
    protected readonly userMapper: BetterAuthUserMapper,
  ) {}

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get current Better-Auth session
   */
  @Query(() => BetterAuthSessionModel, {
    description: 'Get current Better-Auth session',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  async betterAuthSession(@Context() ctx: { req: Request }): Promise<BetterAuthSessionModel | null> {
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
  @Query(() => BetterAuthFeaturesModel, { description: 'Get enabled Better-Auth features' })
  @Roles(RoleEnum.S_EVERYONE)
  betterAuthFeatures(): BetterAuthFeaturesModel {
    return {
      enabled: this.betterAuthService.isEnabled(),
      jwt: this.betterAuthService.isJwtEnabled(),
      passkey: this.betterAuthService.isPasskeyEnabled(),
      socialProviders: this.betterAuthService.getEnabledSocialProviders(),
      twoFactor: this.betterAuthService.isTwoFactorEnabled(),
    };
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
   * Override this method to add custom pre/post sign-in logic.
   */
  @Mutation(() => BetterAuthAuthModel, {
    description: 'Sign in via Better-Auth (email/password)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  async betterAuthSignIn(
    @Args('email') email: string,
    @Args('password') password: string,
    // eslint-disable-next-line unused-imports/no-unused-vars -- Reserved for future cookie/session handling
    @Context() _ctx: { req: Request; res: Response },
  ): Promise<BetterAuthAuthModel> {
    this.ensureEnabled();

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException('Better-Auth API not available');
    }

    try {
      // Call Better-Auth's sign-in endpoint
      const response = (await api.signInEmail({
        body: { email, password },
      })) as BetterAuthSignInResponse | null;

      if (!response) {
        throw new UnauthorizedException('Invalid credentials');
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

        // Get token if JWT plugin is enabled
        const token = this.betterAuthService.isJwtEnabled() ? response.token : undefined;

        return {
          requiresTwoFactor: false,
          session: hasSession(response) ? this.mapSessionInfo(response.session) : null,
          success: true,
          token,
          user: mappedUser ? this.mapToUserModel(mappedUser) : null,
        };
      }

      throw new UnauthorizedException('Invalid credentials');
    } catch (error) {
      this.logger.debug(`Sign-in error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  /**
   * Sign up via Better-Auth
   *
   * Override this method to add custom pre/post sign-up logic (e.g., sending welcome emails).
   */
  @Mutation(() => BetterAuthAuthModel, {
    description: 'Sign up via Better-Auth (email/password)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  async betterAuthSignUp(
    @Args('email') email: string,
    @Args('password') password: string,
    @Args('name', { nullable: true }) name?: string,
  ): Promise<BetterAuthAuthModel> {
    this.ensureEnabled();

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException('Better-Auth API not available');
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
        throw new BadRequestException('Sign-up failed');
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
   * Sign out via Better-Auth
   */
  @Mutation(() => Boolean, { description: 'Sign out via Better-Auth' })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
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
  @Mutation(() => BetterAuthAuthModel, {
    description: 'Verify 2FA code during sign-in',
  })
  @Roles(RoleEnum.S_EVERYONE)
  async betterAuthVerify2FA(
    @Args('code') code: string,
    @Context() ctx: { req: Request },
  ): Promise<BetterAuthAuthModel> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException('Better-Auth API not available');
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
        throw new BadRequestException('2FA verification method not available');
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

      throw new UnauthorizedException('Invalid 2FA code');
    } catch (error) {
      this.logger.debug(`2FA verification error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new UnauthorizedException('Invalid 2FA code');
    }
  }

  // ===========================================================================
  // 2FA Management Mutations
  // ===========================================================================

  /**
   * Enable 2FA for the current user
   * Returns TOTP URI for QR code generation and backup codes
   */
  @Mutation(() => BetterAuth2FASetupModel, {
    description: 'Enable 2FA for the current user',
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  async betterAuthEnable2FA(
    @Args('password') password: string,
    @Context() ctx: { req: Request },
  ): Promise<BetterAuth2FASetupModel> {
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
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  async betterAuthDisable2FA(@Args('password') password: string, @Context() ctx: { req: Request }): Promise<boolean> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      throw new BadRequestException('Two-factor authentication is not enabled on this server');
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
        throw new BadRequestException('2FA disable method not available');
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
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  async betterAuthGenerateBackupCodes(@Context() ctx: { req: Request }): Promise<null | string[]> {
    this.ensureEnabled();

    if (!this.betterAuthService.isTwoFactorEnabled()) {
      throw new BadRequestException('Two-factor authentication is not enabled on this server');
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
        throw new BadRequestException('Generate backup codes method not available');
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
  @Mutation(() => BetterAuthPasskeyChallengeModel, {
    description: 'Get passkey registration challenge for WebAuthn',
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  async betterAuthGetPasskeyChallenge(@Context() ctx: { req: Request }): Promise<BetterAuthPasskeyChallengeModel> {
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
  @Query(() => [BetterAuthPasskeyModel], {
    description: 'List passkeys for the current user',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  async betterAuthListPasskeys(@Context() ctx: { req: Request }): Promise<BetterAuthPasskeyModel[] | null> {
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
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  async betterAuthDeletePasskey(
    @Args('passkeyId') passkeyId: string,
    @Context() ctx: { req: Request },
  ): Promise<boolean> {
    this.ensureEnabled();

    if (!this.betterAuthService.isPasskeyEnabled()) {
      throw new BadRequestException('Passkey authentication is not enabled on this server');
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
        throw new BadRequestException('Delete passkey method not available');
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
      throw new BadRequestException(
        'Better-Auth is not enabled. Check that betterAuth.enabled is not set to false in your environment.',
      );
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
   * Map MappedUser to BetterAuthUserModel
   */
  protected mapToUserModel(user: MappedUser): BetterAuthUserModel {
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
