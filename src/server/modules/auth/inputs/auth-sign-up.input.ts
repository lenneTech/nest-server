import { Field, InputType } from '@nestjs/graphql';
import { CoreAuthSignUpInput } from '../../../../core/modules/auth/inputs/core-auth-sign-up.input';

/**
 * SignUp input
 */
@InputType({ description: 'Description for AuthSignUpInput' })
export class AuthSignUpInput extends CoreAuthSignUpInput {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'firstName', nullable: true })
  firstName: string = undefined;

  @Field({ description: 'lastName', nullable: true })
  lastName: string = undefined;
}
