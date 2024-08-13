import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreModel } from '../../common/models/core-model.model';
import { CoreUserModel } from '../user/core-user.model';

/**
 * CoreAuth model for the response after the sign in
 */
@Restricted(RoleEnum.S_EVERYONE)
@ObjectType({ description: 'CoreAuth', isAbstract: true })
export class CoreAuthModel extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * JavaScript Web Token (JWT)
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'JavaScript Web Token (JWT)', nullable: true })
  token?: string = undefined;

  /**
   * Refresh token
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'Refresh token', nullable: true })
  refreshToken?: string = undefined;

  /**
   * Current user
   */
  @Restricted(RoleEnum.S_EVERYONE)
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
