import { InputType } from 'type-graphql';
import { CoreUserCreateInput } from '../../../../core/modules/user/inputs/core-user-create.input';

/**
 * User input to create a new user
 */
@InputType({ description: 'User input to create a new user' })
export class UserCreateInput extends CoreUserCreateInput {
  // Extend UserCreateInput here
}
