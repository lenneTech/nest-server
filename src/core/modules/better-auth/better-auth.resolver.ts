import { Optional } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Request, Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreBetterAuthAuthModel } from './core-better-auth-auth.model';
import {
  CoreBetterAuth2FASetupModel,
  CoreBetterAuthFeaturesModel,
  CoreBetterAuthPasskeyChallengeModel,
  CoreBetterAuthPasskeyModel,
  CoreBetterAuthSessionModel,
} from './core-better-auth-models';
import { CoreBetterAuthSignUpValidatorService } from './core-better-auth-signup-validator.service';
import { CoreBetterAuthUserMapper } from './core-better-auth-user.mapper';
import { CoreBetterAuthResolver } from './core-better-auth.resolver';
import { CoreBetterAuthService } from './core-better-auth.service';

/**
 * Default BetterAuth GraphQL Resolver
 *
 * This resolver extends CoreBetterAuthResolver and provides the default
 * Better-Auth GraphQL operations. It re-declares all methods with decorators
 * because CoreBetterAuthResolver uses `isAbstract: true`, which means its
 * methods are not registered in the GraphQL schema.
 *
 * Override in your project if you need custom behavior (e.g., sending emails after sign-up).
 *
 * @example
 * ```typescript
 * // In your project - src/server/modules/better-auth/better-auth.resolver.ts
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
 *   override async betterAuthSignUp(
 *     email: string,
 *     password: string,
 *     name?: string,
 *     termsAndPrivacyAccepted?: boolean,
 *   ) {
 *     const result = await super.betterAuthSignUp(email, password, name, termsAndPrivacyAccepted);
 *
 *     // Send welcome email after successful sign-up
 *     if (result.success && result.user) {
 *       await this.emailService.sendWelcomeEmail(result.user.email);
 *     }
 *
 *     return result;
 *   }
 * }
 * ```
 */
@Resolver(() => CoreBetterAuthAuthModel)
@Roles(RoleEnum.ADMIN)
export class DefaultBetterAuthResolver extends CoreBetterAuthResolver {
  constructor(
    protected override readonly betterAuthService: CoreBetterAuthService,
    protected override readonly userMapper: CoreBetterAuthUserMapper,
    @Optional() protected override readonly signUpValidator?: CoreBetterAuthSignUpValidatorService,
  ) {
    super(betterAuthService, userMapper, signUpValidator);
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

  @Query(() => [CoreBetterAuthPasskeyModel], {
    description: 'List passkeys for the current user',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  override async betterAuthListPasskeys(@Context() ctx: { req: Request }): Promise<CoreBetterAuthPasskeyModel[] | null> {
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
    @Context() ctx: { req: Request; res: Response },
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
