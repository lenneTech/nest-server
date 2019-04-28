import { InputType } from 'type-graphql';
import { UserCreateInput as CoreUserCreateInput } from '../../../../core/modules/user/inputs/user-create.input';

/**
 * User input to create a new user
 */
@InputType({ description: 'User input to create a new user' })
export class UserCreateInput extends CoreUserCreateInput {}
