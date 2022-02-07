import { Field, ObjectType } from '@nestjs/graphql';
import { CoreModel } from '../../common/models/core-model.model';

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
  @Field({ description: 'JavaScript Web Token (JWT)' })
  token: string = undefined;

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
