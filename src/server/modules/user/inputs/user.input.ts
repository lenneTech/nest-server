import { InputType } from 'type-graphql';
import { UserInput as CoreUserInput } from '../../../../core/modules/user/inputs/user.input';

/**
 * User input to update a user
 */
@InputType({ description: 'User input' })
export class UserInput extends CoreUserInput {}
