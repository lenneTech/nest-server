import { Field, ObjectType } from 'type-graphql';
import { CoreAuthModel } from '../../../core/modules/auth/core-auth.model';
import { User } from '../user/user.model';

/**
 * CoreAuthModel model for the response after the sign in
 */
@ObjectType({ description: 'Auth' })
export class Auth extends CoreAuthModel {

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * Signed in user
   */
  @Field(type => User, { description: 'User who signed in' })
  user: User;
}
