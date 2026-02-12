import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
import { UnifiedField } from '../../../../core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { CoreUserCreateInput } from '../../../../core/modules/user/inputs/core-user-create.input';

/**
 * User input to create a new user
 */
@InputType({ description: 'User input to create a new user' })
@Restricted(RoleEnum.ADMIN)
export class UserCreateInput extends CoreUserCreateInput {
  // Extend UserCreateInput here
  @UnifiedField({
    description: 'Job Title of the user',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  jobTitle?: string = undefined;
}
