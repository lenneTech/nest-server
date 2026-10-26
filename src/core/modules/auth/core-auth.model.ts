import { ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../common/enums/role.enum.js';
import { CoreModel } from '../../common/models/core-model.model.js';
import { CoreUserModel } from '../user/core-user.model.js';

/**
 * CoreAuth model for the response after the sign in
 */
@ObjectType({ description: 'CoreAuth', isAbstract: true })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAuthModel extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * JSON Web Token(JWT)
   */
  @UnifiedField({
    description: 'JSON Web Token(JWT) used for auth',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  token?: string = undefined;

  /**
   * Refresh token
   */
  @UnifiedField({
    description: 'Refresh JSON Web Token(JWT) used for auth',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
  })
  refreshToken?: string = undefined;

  /**
   * Current user
   */
  @UnifiedField({
    description: 'User who signed in',
    isOptional: false,
    roles: RoleEnum.S_EVERYONE,
    type: () => CoreUserModel,
  })
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
