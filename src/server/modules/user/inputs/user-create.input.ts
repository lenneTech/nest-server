import { InputType } from '@nestjs/graphql';
import { CoreUserCreateInput } from '../../../../core/modules/user/inputs/core-user-create.input';

/**
 * User input to create a new user
 *
 * HINT: All properties (in this class and all classes that extend this class) must be initialized with undefined,
 * otherwise the property will not be recognized via Object.keys (this is necessary for mapping) or will be initialized
 * with a default value that may overwrite an existing value in the DB.
 */
@InputType({ description: 'User input to create a new user' })
export class UserCreateInput extends CoreUserCreateInput {
  // Extend UserCreateInput here
}
