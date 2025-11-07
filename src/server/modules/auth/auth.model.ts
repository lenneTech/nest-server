import { ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../core/common/decorators/restricted.decorator';
import { UnifiedField } from '../../../core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { mapClasses } from '../../../core/common/helpers/model.helper';
import { CoreAuthModel } from '../../../core/modules/auth/core-auth.model';
import { User } from '../user/user.model';

/**
 * Authentication data
 */
@ObjectType({ description: 'Authentication data' })
@Restricted(RoleEnum.ADMIN)
export class Auth extends CoreAuthModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * Signed-in user
   */
  @UnifiedField({
    description: 'User who signed in',
    roles: RoleEnum.S_EVERYONE,
    type: () => User,
  })
  override user: User = undefined;

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
    return mapClasses(input, { user: User }, this);
  }
}
