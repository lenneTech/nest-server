import { Field, ObjectType } from '@nestjs/graphql';
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
  @Field((type) => User, { description: 'User who signed in' })
  user: User = undefined;

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * Initialize instance with default values instead of undefined
   */
  init() {
    super.init();
    // Nothing more to initialize yet
    return this;
  }
}
