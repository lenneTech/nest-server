import { Optional } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Request, Response } from 'express';

import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { CoreBetterAuthAuthModel } from '../../../core/modules/better-auth/core-better-auth-auth.model';
import { CoreBetterAuthEmailVerificationService } from '../../../core/modules/better-auth/core-better-auth-email-verification.service';
import { CoreBetterAuthMigrationStatusModel } from '../../../core/modules/better-auth/core-better-auth-migration-status.model';
import {
  CoreBetterAuth2FASetupModel,
  CoreBetterAuthFeaturesModel,
  CoreBetterAuthPasskeyChallengeModel,
  CoreBetterAuthPasskeyModel,
  CoreBetterAuthSessionModel,
} from '../../../core/modules/better-auth/core-better-auth-models';
import { CoreBetterAuthSignUpValidatorService } from '../../../core/modules/better-auth/core-better-auth-signup-validator.service';
import { CoreBetterAuthUserMapper } from '../../../core/modules/better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthResolver } from '../../../core/modules/better-auth/core-better-auth.resolver';
import { CoreBetterAuthService } from '../../../core/modules/better-auth/core-better-auth.service';

/**
 * Server BetterAuth GraphQL Resolver
 *
 * This resolver extends CoreBetterAuthResolver and exposes all GraphQL operations.
 * The `isAbstract: true` pattern in NestJS GraphQL requires concrete classes to
 * explicitly override and decorate methods for them to be registered in the schema.
 *
 * Each method delegates to the parent implementation via `super.methodName()`.
 * Override any method to add custom behavior (e.g., sending welcome emails after signup).
 *
 * @example
 * ```typescript
 * // Add custom behavior after sign-up
 * override async betterAuthSignUp(
 *   email: string,
 *   password: string,
 *   name?: string,
 *   termsAndPrivacyAccepted?: boolean,
 * ) {
 *   const result = await super.betterAuthSignUp(email, password, name, termsAndPrivacyAccepted);
 *
 *   if (result.success && result.user) {
 *     await this.emailService.sendWelcomeEmail(result.user.email);
 *   }
 *
 *   return result;
 * }
 * ```
 */
@Resolver(() => CoreBetterAuthAuthModel)
@Roles(RoleEnum.ADMIN)
export class BetterAuthResolver extends CoreBetterAuthResolver {
  constructor(
    protected override readonly betterAuthService: CoreBetterAuthService,
    protected override readonly userMapper: CoreBetterAuthUserMapper,
    @Optional() protected override readonly signUpValidator?: CoreBetterAuthSignUpValidatorService,
    @Optional() protected override readonly emailVerificationService?: CoreBetterAuthEmailVerificationService,
  ) {
    super(betterAuthService, userMapper, signUpValidator, emailVerificationService);
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  @Query(() => CoreBetterAuthSessionModel, {
    description: 'Get current Better-Auth session',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  override async betterAuthSession(@Context() ctx: { req: Request }): Promise<CoreBetterAuthSessionModel | null> {
    return super.betterAuthSession(ctx);
  }

  @Query(() => Boolean, { description: 'Check if Better-Auth is enabled' })
  @Roles(RoleEnum.S_EVERYONE)
  override betterAuthEnabled(): boolean {
    return super.betterAuthEnabled();
  }

  @Query(() => CoreBetterAuthFeaturesModel, { description: 'Get enabled Better-Auth features' })
  @Roles(RoleEnum.S_EVERYONE)
  override betterAuthFeatures(): CoreBetterAuthFeaturesModel {
    return super.betterAuthFeatures();
  }

  @Query(() => CoreBetterAuthMigrationStatusModel, {
    description: 'Get migration status from Legacy Auth to Better-Auth (IAM) - Admin only',
  })
  @Roles(RoleEnum.ADMIN)
  override async betterAuthMigrationStatus(): Promise<CoreBetterAuthMigrationStatusModel> {
    return super.betterAuthMigrationStatus();
  }

  @Query(() => String, {
    description: 'Get fresh JWT token for the current session (requires valid session)',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  override async betterAuthToken(@Context() ctx: { req: Request }): Promise<null | string> {
    return super.betterAuthToken(ctx);
  }

  @Query(() => [CoreBetterAuthPasskeyModel], {
    description: 'List passkeys for the current user',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  override async betterAuthListPasskeys(
    @Context() ctx: { req: Request },
  ): Promise<CoreBetterAuthPasskeyModel[] | null> {
    return super.betterAuthListPasskeys(ctx);
  }

  // ===========================================================================
  // Authentication Mutations
  // ===========================================================================

  @Mutation(() => CoreBetterAuthAuthModel, {
    description: 'Sign in via Better-Auth (email/password)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  override async betterAuthSignIn(
    @Args('email') email: string,
    @Args('password') password: string,
    @Context() ctx?: { req: Request; res: Response },
  ): Promise<CoreBetterAuthAuthModel> {
    return super.betterAuthSignIn(email, password, ctx);
  }

  @Mutation(() => CoreBetterAuthAuthModel, {
    description: 'Sign up via Better-Auth (email/password)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  override async betterAuthSignUp(
    @Args('email') email: string,
    @Args('password') password: string,
    @Args('name', { nullable: true }) name?: string,
    @Args('termsAndPrivacyAccepted', { nullable: true }) termsAndPrivacyAccepted?: boolean,
  ): Promise<CoreBetterAuthAuthModel> {
    return super.betterAuthSignUp(email, password, name, termsAndPrivacyAccepted);
  }

  @Mutation(() => Boolean, { description: 'Sign out via Better-Auth' })
  @Roles(RoleEnum.S_USER)
  override async betterAuthSignOut(@Context() ctx: { req: Request }): Promise<boolean> {
    return super.betterAuthSignOut(ctx);
  }

  // ===========================================================================
  // 2FA Mutations
  // ===========================================================================

  @Mutation(() => CoreBetterAuthAuthModel, {
    description: 'Verify 2FA code during sign-in',
  })
  @Roles(RoleEnum.S_EVERYONE)
  override async betterAuthVerify2FA(
    @Args('code') code: string,
    @Context() ctx: { req: Request },
  ): Promise<CoreBetterAuthAuthModel> {
    return super.betterAuthVerify2FA(code, ctx);
  }

  @Mutation(() => CoreBetterAuth2FASetupModel, {
    description: 'Enable 2FA for the current user',
  })
  @Roles(RoleEnum.S_USER)
  override async betterAuthEnable2FA(
    @Args('password') password: string,
    @Context() ctx: { req: Request },
  ): Promise<CoreBetterAuth2FASetupModel> {
    return super.betterAuthEnable2FA(password, ctx);
  }

  @Mutation(() => Boolean, {
    description: 'Disable 2FA for the current user',
  })
  @Roles(RoleEnum.S_USER)
  override async betterAuthDisable2FA(
    @Args('password') password: string,
    @Context() ctx: { req: Request },
  ): Promise<boolean> {
    return super.betterAuthDisable2FA(password, ctx);
  }

  @Mutation(() => [String], {
    description: 'Generate new backup codes for 2FA',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  override async betterAuthGenerateBackupCodes(@Context() ctx: { req: Request }): Promise<null | string[]> {
    return super.betterAuthGenerateBackupCodes(ctx);
  }

  // ===========================================================================
  // Passkey Mutations
  // ===========================================================================

  @Mutation(() => CoreBetterAuthPasskeyChallengeModel, {
    description: 'Get passkey registration challenge for WebAuthn',
  })
  @Roles(RoleEnum.S_USER)
  override async betterAuthGetPasskeyChallenge(
    @Context() ctx: { req: Request },
  ): Promise<CoreBetterAuthPasskeyChallengeModel> {
    return super.betterAuthGetPasskeyChallenge(ctx);
  }

  @Mutation(() => Boolean, {
    description: 'Delete a passkey by ID',
  })
  @Roles(RoleEnum.S_USER)
  override async betterAuthDeletePasskey(
    @Args('passkeyId') passkeyId: string,
    @Context() ctx: { req: Request },
  ): Promise<boolean> {
    return super.betterAuthDeletePasskey(passkeyId, ctx);
  }
}
