import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Request, Response } from 'express';

import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { AuthGuardStrategy } from '../../../core/modules/auth/auth-guard-strategy.enum';
import { AuthGuard } from '../../../core/modules/auth/guards/auth.guard';
import { BetterAuthAuthModel } from '../../../core/modules/better-auth/better-auth-auth.model';
import {
  BetterAuth2FASetupModel,
  BetterAuthFeaturesModel,
  BetterAuthPasskeyChallengeModel,
  BetterAuthPasskeyModel,
  BetterAuthSessionModel,
} from '../../../core/modules/better-auth/better-auth-models';
import { BetterAuthUserMapper } from '../../../core/modules/better-auth/better-auth-user.mapper';
import { BetterAuthService } from '../../../core/modules/better-auth/better-auth.service';
import { CoreBetterAuthResolver } from '../../../core/modules/better-auth/core-better-auth.resolver';

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
 * override async betterAuthSignUp(email: string, password: string, name?: string) {
 *   const result = await super.betterAuthSignUp(email, password, name);
 *
 *   if (result.success && result.user) {
 *     await this.emailService.sendWelcomeEmail(result.user.email);
 *   }
 *
 *   return result;
 * }
 * ```
 */
@Resolver(() => BetterAuthAuthModel)
@Roles(RoleEnum.ADMIN)
export class BetterAuthResolver extends CoreBetterAuthResolver {
  constructor(
    protected override readonly betterAuthService: BetterAuthService,
    protected override readonly userMapper: BetterAuthUserMapper,
  ) {
    super(betterAuthService, userMapper);
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  @Query(() => BetterAuthSessionModel, {
    description: 'Get current Better-Auth session',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  override async betterAuthSession(@Context() ctx: { req: Request }): Promise<BetterAuthSessionModel | null> {
    return super.betterAuthSession(ctx);
  }

  @Query(() => Boolean, { description: 'Check if Better-Auth is enabled' })
  @Roles(RoleEnum.S_EVERYONE)
  override betterAuthEnabled(): boolean {
    return super.betterAuthEnabled();
  }

  @Query(() => BetterAuthFeaturesModel, { description: 'Get enabled Better-Auth features' })
  @Roles(RoleEnum.S_EVERYONE)
  override betterAuthFeatures(): BetterAuthFeaturesModel {
    return super.betterAuthFeatures();
  }

  @Query(() => [BetterAuthPasskeyModel], {
    description: 'List passkeys for the current user',
    nullable: true,
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  override async betterAuthListPasskeys(@Context() ctx: { req: Request }): Promise<BetterAuthPasskeyModel[] | null> {
    return super.betterAuthListPasskeys(ctx);
  }

  // ===========================================================================
  // Authentication Mutations
  // ===========================================================================

  @Mutation(() => BetterAuthAuthModel, {
    description: 'Sign in via Better-Auth (email/password)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  override async betterAuthSignIn(
    @Args('email') email: string,
    @Args('password') password: string,
    @Context() ctx: { req: Request; res: Response },
  ): Promise<BetterAuthAuthModel> {
    return super.betterAuthSignIn(email, password, ctx);
  }

  @Mutation(() => BetterAuthAuthModel, {
    description: 'Sign up via Better-Auth (email/password)',
  })
  @Roles(RoleEnum.S_EVERYONE)
  override async betterAuthSignUp(
    @Args('email') email: string,
    @Args('password') password: string,
    @Args('name', { nullable: true }) name?: string,
  ): Promise<BetterAuthAuthModel> {
    return super.betterAuthSignUp(email, password, name);
  }

  @Mutation(() => Boolean, { description: 'Sign out via Better-Auth' })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  override async betterAuthSignOut(@Context() ctx: { req: Request }): Promise<boolean> {
    return super.betterAuthSignOut(ctx);
  }

  // ===========================================================================
  // 2FA Mutations
  // ===========================================================================

  @Mutation(() => BetterAuthAuthModel, {
    description: 'Verify 2FA code during sign-in',
  })
  @Roles(RoleEnum.S_EVERYONE)
  override async betterAuthVerify2FA(
    @Args('code') code: string,
    @Context() ctx: { req: Request },
  ): Promise<BetterAuthAuthModel> {
    return super.betterAuthVerify2FA(code, ctx);
  }

  @Mutation(() => BetterAuth2FASetupModel, {
    description: 'Enable 2FA for the current user',
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  override async betterAuthEnable2FA(
    @Args('password') password: string,
    @Context() ctx: { req: Request },
  ): Promise<BetterAuth2FASetupModel> {
    return super.betterAuthEnable2FA(password, ctx);
  }

  @Mutation(() => Boolean, {
    description: 'Disable 2FA for the current user',
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
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
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  override async betterAuthGenerateBackupCodes(@Context() ctx: { req: Request }): Promise<null | string[]> {
    return super.betterAuthGenerateBackupCodes(ctx);
  }

  // ===========================================================================
  // Passkey Mutations
  // ===========================================================================

  @Mutation(() => BetterAuthPasskeyChallengeModel, {
    description: 'Get passkey registration challenge for WebAuthn',
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  override async betterAuthGetPasskeyChallenge(
    @Context() ctx: { req: Request },
  ): Promise<BetterAuthPasskeyChallengeModel> {
    return super.betterAuthGetPasskeyChallenge(ctx);
  }

  @Mutation(() => Boolean, {
    description: 'Delete a passkey by ID',
  })
  @Roles(RoleEnum.S_USER)
  @UseGuards(AuthGuard(AuthGuardStrategy.JWT))
  override async betterAuthDeletePasskey(
    @Args('passkeyId') passkeyId: string,
    @Context() ctx: { req: Request },
  ): Promise<boolean> {
    return super.betterAuthDeletePasskey(passkeyId, ctx);
  }
}
