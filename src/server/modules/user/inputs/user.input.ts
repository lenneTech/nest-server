import { InputType } from '@nestjs/graphql';
import { CoreUserInput } from '../../../../core/modules/user/inputs/core-user.input';

/**
 * User input to update a user
 *
 * HINT: All properties (in this class and all classes that extend this class) must be initialized with undefined,
 * otherwise the property will not be recognized via Object.keys (this is necessary for mapping) or will be initialized
 * with a default value that may overwrite an existing value in the DB.
 */
@InputType({ description: 'User input' })
export class UserInput extends CoreUserInput {
  // Extend UserInput here
}
