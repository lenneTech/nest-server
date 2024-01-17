import { InputType } from '@nestjs/graphql';

import { CoreAuthSignInInput } from './core-auth-sign-in.input';

/**
 * SignUp input
 */
@InputType({ description: 'Sign-up input' })
export class CoreAuthSignUpInput extends CoreAuthSignInInput {}
