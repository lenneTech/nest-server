import { InputType } from 'type-graphql';
import { CoreUserInput } from '../../../../core/modules/user/inputs/core-user.input';

/**
 * User input to update a user
 */
@InputType({ description: 'User input' })
export class UserInput extends CoreUserInput {
  // Extend UserInput here
}
