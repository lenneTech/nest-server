import { Field, InputType } from '@nestjs/graphql';
import { CoreInput } from '../../../common/inputs/core-input.input';

/**
 * SignUp input
 */
@InputType({ description: 'Sign-up input' })
export class CoreAuthSignUpInput extends CoreInput {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'Device ID', nullable: true })
  deviceId?: string = undefined;

  @Field({ description: 'Email', nullable: false })
  email: string = undefined;

  @Field({ description: 'Password', nullable: false })
  password: string = undefined;
}
