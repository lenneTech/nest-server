import { Args, Info, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GraphQLResolveInfo } from 'graphql';
import { Auth } from './auth.model';
import { AuthService } from './auth.service';
import { AuthSignInInput } from './inputs/auth-sign-in.input';
import { AuthSignUpInput } from './inputs/auth-sign-up.input';

/**
 * Authentication resolver for the sign in
 */
@Resolver(() => Auth)
export class AuthResolver {
  /**
   * Integrate services
   */
  constructor(private readonly authService: AuthService) {}

  /**
   * SignIn for User
   */
  @Query(() => Auth, { description: 'Sign in and get JWT token' })
  async signIn(@Info() info: GraphQLResolveInfo, @Args('input') input: AuthSignInInput): Promise<Auth> {
    return this.authService.signIn(input, {
      fieldSelection: { info, select: 'signIn' },
      inputType: AuthSignInInput,
    });
  }

  /**
   * Sign up for user
   */
  @Mutation(() => Auth, {
    description: 'Sign up user and get JWT token',
  })
  async signUp(@Info() info: GraphQLResolveInfo, @Args('input') input: AuthSignUpInput): Promise<Auth> {
    return this.authService.signUp(input, {
      fieldSelection: { info, select: 'signUp' },
    });
  }
}
