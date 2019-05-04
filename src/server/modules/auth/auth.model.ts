import { Field, ObjectType } from 'type-graphql';
import { CoreAuth } from '../../../core/modules/auth/core-auth.model';
import { User } from '../user/user.model';

/**
 * CoreAuth model for the response after the sign in
 */
@ObjectType({ description: 'CoreAuth' })
export class Auth extends CoreAuth {

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * Signed in user
   */
  @Field(type => User, { description: 'User who signed in' })
  user: User;
}
