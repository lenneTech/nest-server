import { Args, Context, Info, Mutation, Resolver } from '@nestjs/graphql';
import { Response as ResponseType } from 'express';
import { GraphQLResolveInfo } from 'graphql';
import { ConfigService } from '../../../core/common/services/config.service';
import { CoreAuthResolver } from '../../../core/modules/auth/core-auth.resolver';
import { Auth } from './auth.model';
import { AuthService } from './auth.service';
import { AuthSignInInput } from './inputs/auth-sign-in.input';
import { AuthSignUpInput } from './inputs/auth-sign-up.input';

/**
 * Authentication resolver for the sign in
 */
@Resolver(() => Auth)
export class AuthResolver extends CoreAuthResolver {
  /**
   * Integrate services
   */
  constructor(
    protected override readonly authService: AuthService,
    protected override readonly configService: ConfigService
  ) {
    super(authService, configService);
  }

  /**
   * SignIn for User
   */
  @Mutation(() => Auth, { description: 'Sign in and get JWT token' })
  override async signIn(
    @Info() info: GraphQLResolveInfo,
    @Context() ctx: { res: ResponseType },
    @Args('input') input: AuthSignInInput
  ): Promise<Auth> {
    const result = await this.authService.signIn(input, {
      fieldSelection: { info, select: 'signIn' },
      inputType: AuthSignInInput,
    });
    return this.processCookies(ctx, result);
  }

  /**
   * Sign up for user
   */
  @Mutation(() => Auth, {
    description: 'Sign up user and get JWT token',
  })
  override async signUp(
    @Info() info: GraphQLResolveInfo,
    @Context() ctx: { res: ResponseType },
    @Args('input') input: AuthSignUpInput
  ): Promise<Auth> {
    const result = await this.authService.signUp(input, {
      fieldSelection: { info, select: 'signUp' },
    });
    return this.processCookies(ctx, result);
  }
}
