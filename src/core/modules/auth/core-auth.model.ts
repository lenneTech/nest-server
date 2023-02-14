import { Field, ObjectType } from '@nestjs/graphql';
import { CoreModel } from '../../common/models/core-model.model';
import { CoreUserModel } from '../user/core-user.model';

/**
 * CoreAuth model for the response after the sign in
 */
@ObjectType({ description: 'CoreAuth', isAbstract: true })
export class CoreAuthModel extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * JavaScript Web Token (JWT)
   */
  @Field({ description: 'JavaScript Web Token (JWT)', nullable: true })
  token?: string = undefined;

  /**
   * Refresh token
   */
  @Field({ description: 'Refresh token', nullable: true })
  refreshToken?: string = undefined;

  /**
   * Current user
   */
  @Field({ description: 'Current user' })
  user: CoreUserModel = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Initialize instance with default values instead of undefined
   */
  override init() {
    super.init();
    // Nothing more to initialize yet
    return this;
  }

  /**
   * Map input
   */
  override map(input) {
    super.map(input);
    // There is nothing to map yet. Non-primitive variables should always be mapped.
    // If something comes up, you can use `mapClasses` / `mapClassesAsync` from ModelHelper.
    return this;
  }
}
