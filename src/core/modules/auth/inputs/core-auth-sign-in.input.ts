import { Field, InputType } from '@nestjs/graphql';
import { CoreInput } from '../../../common/inputs/core-input.input';

/**
 * SignIn input
 */
@InputType({ description: 'Sign-in input' })
export class CoreAuthSignInInput extends CoreInput {
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
