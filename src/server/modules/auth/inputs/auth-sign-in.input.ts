import { InputType } from '@nestjs/graphql';
import { CoreAuthSignInInput } from '../../../../core/modules/auth/inputs/core-auth-sign-in.input';

/**
 * SignIn input
 */
@InputType({ description: 'Description for AuthSignInInput' })
export class AuthSignInInput extends CoreAuthSignInInput {
  // Extend UserInput here
}
